import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Platform } from "react-native";
import {
  ApiError,
  clearSession,
  readSession,
  request,
  writeSession,
} from "./lib/api";
import { demoEnabled, policyVersion } from "./lib/config";
import {
  emptyPreferences,
  type Bootstrap,
  type Item,
  type FeedInput,
  type Preferences,
  type Session,
  type User,
} from "./lib/types";
import demo from "./lib/demo.json";
import { disconnectWallet } from "./lib/wallet-connector";

const empty: Bootstrap = {
  items: [],
  drafts: [],
  preferences: emptyPreferences,
  feeds: [],
  community_feeds: [],
  connections: [],
  distributions: [],
};
function previewData(): Bootstrap {
  const items = demoEnabled ? (demo as Item[]) : [];
  const drafts: Item[] = items.map((item) => ({
    ...item,
    id: `preview-${item.id}`,
    creator: "Ziipa Studio",
    visibility: "draft",
  }));
  const nft = drafts.find((item) => item.category === "nft");
  if (nft)
    drafts.push(
      {
        ...nft,
        id: "preview-tidal",
        title: "Tidal / 002",
        cover: "/media/ocean.jpg",
      },
      {
        ...nft,
        id: "preview-frequency",
        title: "Frequency / 003",
        cover: "/media/dj.jpg",
      },
    );
  return {
    ...empty,
    items,
    drafts,
    connections: [
      {
        provider: "bluesky",
        name: "Bluesky / AT Protocol",
        capability: "Posts and portable identity",
        status: "connected",
        handle: "ziipa.studio",
        configured: true,
      },
      {
        provider: "instagram",
        name: "Instagram",
        capability: "Professional account posts and Reels",
        status: "connected",
        handle: "@ziipa.studio",
        configured: true,
      },
      {
        provider: "tiktok",
        name: "TikTok",
        capability: "Video and photo publishing",
        status: "connected",
        handle: "@ziipa",
        configured: true,
      },
      ...(
        [
          ["facebook", "Facebook", "Pages, video and Reels"],
          ["twitch", "Twitch", "Live broadcasting and channel library"],
          ["youtube", "YouTube", "Videos, Shorts and live streams"],
        ] as const
      ).map(([provider, name, capability]) => ({
        provider,
        name,
        capability,
        status: "disconnected" as const,
        handle: "",
        configured: false,
      })),
    ],
  };
}
type State = {
  session: Session | null;
  guest: boolean;
  loading: boolean;
  error: string;
  data: Bootstrap;
  refreshing: boolean;
  restore: () => Promise<void>;
  enterGuest: () => void;
  authenticate: (
    email: string,
    password: string,
    name?: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
  forgetSession: () => Promise<void>;
  refresh: () => Promise<void>;
  api: <T>(path: string, data?: unknown) => Promise<T>;
  preferences: (patch: Partial<Preferences>) => Promise<void>;
  toggle: (key: "liked" | "saved", id: string) => Promise<void>;
  savePreviewDraft: (item: Item) => void;
  savePreviewFeed: (rule: FeedInput) => void;
};
const Context = createContext<State | null>(null);
export function useZiipa() {
  const context = useContext(Context);
  if (!context) throw new Error("ZiipaProvider is missing");
  return context;
}
export function ZiipaProvider({ children }: React.PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const browserPreview = Platform.OS === "web" && demoEnabled;
  const [guest, setGuest] = useState(browserPreview);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<Bootstrap>(() =>
    browserPreview ? previewData() : empty,
  );
  const dataRef = useRef(data);
  const activeToken = useRef<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const putData = useCallback((value: Bootstrap) => {
    dataRef.current = value;
    setData(value);
  }, []);
  const forgetSession = useCallback(async () => {
    void disconnectWallet().catch(() => {});
    activeToken.current = null;
    queue.current = Promise.resolve();
    try {
      await clearSession();
    } finally {
      setSession(null);
      setGuest(false);
      putData(empty);
      setError("");
    }
  }, [putData]);
  const api = useCallback(
    async <T,>(path: string, body?: unknown): Promise<T> => {
      if (!session || activeToken.current !== session.access_token)
        throw new Error("Sign in to use this creator tool.");
      try {
        const result = await request<T>(path, session.access_token, body);
        if (activeToken.current !== session.access_token)
          throw new Error("Session changed. Please try again.");
        return result;
      } catch (e) {
        if (
          e instanceof ApiError &&
          e.status === 401 &&
          activeToken.current === session.access_token
        )
          await forgetSession();
        throw e;
      }
    },
    [session, forgetSession],
  );
  const restore = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const saved = await readSession();
      if (saved) {
        const [user, bootstrap] = await Promise.all([
          request<User>("/api/me", saved.access_token),
          request<Bootstrap>("/api/creator/bootstrap", saved.access_token),
        ]);
        activeToken.current = saved.access_token;
        setSession({ ...saved, user });
        putData(bootstrap);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) await forgetSession();
      else setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [forgetSession, putData]);
  useEffect(() => {
    void restore();
  }, [restore]);
  const refresh = useCallback(async () => {
    if (!session) return;
    setRefreshing(true);
    setError("");
    try {
      putData(await api<Bootstrap>("/api/creator/bootstrap"));
    } catch (e) {
      if (activeToken.current === session.access_token)
        setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [session, api, putData]);
  async function authenticate(email: string, password: string, name?: string) {
    const result = await request<Session | { verification_required: true; message: string }>(
      `/api/mobile/auth/${name === undefined ? "login" : "register"}`,
      undefined,
      {
        email: email.trim(),
        password,
        ...(name === undefined
          ? {}
          : {
              name: name.trim(),
              accepted_policies: true,
              adult_confirmed: true,
              policy_version: policyVersion,
            }),
      },
    );
    if ('verification_required' in result) throw new Error(result.message);
    await writeSession(result);
    const user = await request<User>("/api/me", result.access_token);
    activeToken.current = result.access_token;
    setSession({ ...result, user });
    setGuest(false);
    setError("");
    try {
      const bootstrap = await request<Bootstrap>(
        "/api/creator/bootstrap",
        result.access_token,
      );
      if (activeToken.current === result.access_token) putData(bootstrap);
    } catch (e) {
      if (activeToken.current === result.access_token) {
        putData(empty);
        setError((e as Error).message);
      }
    }
  }
  async function logout() {
    if (session) await api("/api/mobile/auth/logout", {});
    await forgetSession();
  }
  function enterGuest() {
    setGuest(true);
    setError("");
    putData(previewData());
  }
  function savePreviewDraft(item: Item) {
    if (!guest || !demoEnabled)
      throw new Error("Preview drafts are only available in sample mode.");
    const draft: Item = {
      ...item,
      demo: true,
      visibility: "draft",
      creator_id: undefined,
      creator: "Ziipa Studio",
    };
    putData({
      ...dataRef.current,
      drafts: [
        draft,
        ...dataRef.current.drafts.filter((i) => i.id !== draft.id),
      ],
    });
  }
  function savePreviewFeed(rule: FeedInput) {
    if (!guest || !demoEnabled) throw new Error("Sample mode is required.");
    putData({
      ...dataRef.current,
      feeds: [
        ...dataRef.current.feeds,
        { ...rule, shared: false, id: `preview-feed-${Date.now()}` },
      ],
    });
  }
  function updatePreferences(
    transform: (current: Preferences) => Preferences,
  ): Promise<void> {
    if (guest && demoEnabled) {
      putData({
        ...dataRef.current,
        preferences: transform(dataRef.current.preferences),
      });
      return Promise.resolve();
    }
    const operation = queue.current
      .catch(() => {})
      .then(async () => {
        const updated = await api<Preferences>(
          "/api/creator/preferences",
          transform(dataRef.current.preferences),
        );
        putData({ ...dataRef.current, preferences: updated });
      });
    queue.current = operation;
    return operation;
  }
  const preferences = (patch: Partial<Preferences>) =>
    updatePreferences((current) => ({ ...current, ...patch }));
  const toggle = (key: "liked" | "saved", id: string) =>
    updatePreferences((current) => ({
      ...current,
      [key]: current[key].includes(id)
        ? current[key].filter((x) => x !== id)
        : [...current[key], id],
    }));
  return (
    <Context.Provider
      value={{
        session,
        guest,
        loading,
        error,
        data,
        refreshing,
        api,
        restore,
        enterGuest,
        authenticate,
        logout,
        forgetSession,
        refresh,
        preferences,
        toggle,
        savePreviewDraft,
        savePreviewFeed,
      }}
    >
      {children}
    </Context.Provider>
  );
}
