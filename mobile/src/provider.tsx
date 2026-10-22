import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState, Platform } from "react-native";
import {
  ApiError,
  clearSession,
  readSession,
  request,
  writeSession,
} from "./lib/api";
import { demoEnabled, policyVersion, portalMode } from "./lib/config";
import { clearDraftMedia } from "./lib/local-media";
import {
  emptyPreferences,
  type Bootstrap,
  type Item,
  type FeedInput,
  type Preferences,
  type ProfileImages,
  type Session,
  type User,
} from "./lib/types";
import demo from "./lib/demo.json";
import { disconnectWallet } from "./lib/wallet-connector";
import { emptyNetworkHub, type NetworkHub } from "./lib/network-hub";
import { applyConfirmedEditorItem } from "./lib/editor-save";
import { createProfileImageSync } from "./lib/profile-sync";
import { useTheme } from "./theme";

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
        status: "disconnected",
        handle: "",
        configured: false,
      },
      {
        provider: "instagram",
        name: "Instagram",
        capability: "Professional account posts and Reels",
        status: "disconnected",
        handle: "",
        configured: false,
      },
      {
        provider: "tiktok",
        name: "TikTok",
        capability: "Video and photo publishing",
        status: "disconnected",
        handle: "",
        configured: false,
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
  refresh: (options?: { throwOnError?: boolean }) => Promise<void>;
  recordSavedItem: (item: Item, ownerToken: string) => void;
  recordProfileImages: (profile: ProfileImages, ownerToken: string) => void;
  refreshProfileImages: () => Promise<void>;
  api: <T>(path: string, data?: unknown) => Promise<T>;
  preferences: (patch: Partial<Preferences>) => Promise<void>;
  toggle: (key: "liked" | "saved", id: string) => Promise<void>;
  savePreviewDraft: (item: Item) => void;
  savePreviewFeed: (rule: FeedInput) => void;
  previewNetworks: NetworkHub;
  savePreviewNetworks: (hub: NetworkHub) => void;
};
const Context = createContext<State | null>(null);
export function useZiipa() {
  const context = useContext(Context);
  if (!context) throw new Error("ZiipaProvider is missing");
  return context;
}
export function ZiipaProvider({ children }: React.PropsWithChildren) {
  useTheme();
  const [session, setSession] = useState<Session | null>(null);
  const browserPreview = Platform.OS === "web" && demoEnabled && !portalMode;
  const [guest, setGuest] = useState(browserPreview);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [previewNetworks, setPreviewNetworks] =
    useState<NetworkHub>(emptyNetworkHub);
  const [data, setData] = useState<Bootstrap>(() =>
    browserPreview ? previewData() : empty,
  );
  const dataRef = useRef(data);
  const refreshEpoch = useRef(0);
  const activeToken = useRef<string | null>(null);
  const profileOwnerToken = useRef<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const putData = useCallback((value: Bootstrap) => {
    dataRef.current = value;
    setData(value);
  }, []);
  const profileSync = useRef<ReturnType<typeof createProfileImageSync> | null>(
    null,
  );
  if (!profileSync.current)
    profileSync.current = createProfileImageSync({
      currentToken: () => activeToken.current,
      read: (token) => request<ProfileImages>("/api/creator/profile", token),
      apply: (profile) => {
        profileOwnerToken.current = activeToken.current;
        putData({ ...dataRef.current, profile });
      },
    });
  const forgetSession = useCallback(async () => {
    clearDraftMedia();
    void disconnectWallet().catch(() => {});
    activeToken.current = null;
    profileOwnerToken.current = null;
    profileSync.current?.invalidate();
    queue.current = Promise.resolve();
    try {
      await clearSession();
    } finally {
      setSession(null);
      setGuest(false);
      putData(empty);
      setPreviewNetworks(emptyNetworkHub());
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
        profileOwnerToken.current = saved.access_token;
        profileSync.current?.invalidate();
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
  useEffect(() => {
    if (!portalMode || !session) return;
    // A different browser tab may change the HttpOnly account cookie. The
    // expected-user header also makes server-side writes fail closed during
    // the interval before this visibility check runs.
    let checking = false;
    const check = () => {
      if (checking || document.visibilityState !== "visible") return;
      checking = true;
      void api<User>("/api/me")
        .catch(() => {})
        .finally(() => {
          checking = false;
        });
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    const interval = setInterval(check, 60000);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      clearInterval(interval);
    };
  }, [session, api]);
  const refresh = useCallback(
    async (options?: { throwOnError?: boolean }) => {
      if (!session) return;
      const epoch = ++refreshEpoch.current;
      const profileRead = profileSync.current!.beginBootstrap();
      setRefreshing(true);
      setError("");
      try {
        const bootstrap = await api<Bootstrap>("/api/creator/bootstrap");
        if (
          epoch === refreshEpoch.current &&
          activeToken.current === session.access_token
        ) {
          // Keep newer profile images without dropping unrelated refreshed data.
          const profileIsCurrent =
            profileSync.current!.acceptBootstrap(
              profileRead,
              session.access_token,
            ) || profileOwnerToken.current !== session.access_token;
          profileOwnerToken.current = session.access_token;
          putData(
            profileIsCurrent
              ? bootstrap
              : { ...bootstrap, profile: dataRef.current.profile },
          );
        }
      } catch (e) {
        if (
          epoch === refreshEpoch.current &&
          activeToken.current === session.access_token
        )
          setError((e as Error).message);
        if (options?.throwOnError) throw e;
      } finally {
        if (epoch === refreshEpoch.current) setRefreshing(false);
      }
    },
    [session, api, putData],
  );
  const recordProfileImages = useCallback(
    (profile: ProfileImages, ownerToken: string) => {
      if (!session || guest || session.access_token !== ownerToken) return;
      profileSync.current?.record(profile, ownerToken);
    },
    [session, guest],
  );
  const refreshProfileImages = useCallback(async () => {
    if (!session || guest || activeToken.current !== session.access_token)
      return;
    try {
      await profileSync.current?.refresh(session.access_token);
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.status === 401 &&
        activeToken.current === session.access_token
      )
        await forgetSession();
      throw cause;
    }
  }, [session, guest, forgetSession]);
  useEffect(() => {
    if (!session || guest) return;
    let foreground = AppState.currentState === "active",
      pending = false;
    const sync = () => {
      if (pending) return;
      pending = true;
      void refreshProfileImages()
        .catch(() => {
          // A failed read retains the last confirmed artwork; never replay a save.
        })
        .finally(() => {
          pending = false;
        });
    };
    const listener = AppState.addEventListener("change", (next) => {
      const active = next === "active";
      if (active && !foreground) sync();
      foreground = active;
    });
    if (Platform.OS !== "web") return () => listener.remove();
    const visible = () => {
      if (document.visibilityState === "visible") sync();
    };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      listener.remove();
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [session, guest, refreshProfileImages]);
  const recordSavedItem = useCallback(
    (item: Item, ownerToken: string) => {
      if (
        !session ||
        guest ||
        activeToken.current !== ownerToken ||
        session.access_token !== ownerToken
      )
        return;
      const next = applyConfirmedEditorItem(
        dataRef.current,
        item,
        session.user.id,
      );
      if (next === dataRef.current) return;
      // A read started before this acknowledged write cannot replace its receipt.
      refreshEpoch.current++;
      setRefreshing(false);
      putData(next);
    },
    [session, guest, putData],
  );
  async function authenticate(email: string, password: string, name?: string) {
    const result = await request<
      Session | { verification_required: true; message: string }
    >(
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
    if ("verification_required" in result) throw new Error(result.message);
    await writeSession(result);
    const user = await request<User>("/api/me", result.access_token);
    activeToken.current = result.access_token;
    profileOwnerToken.current = null;
    // Never present a prior account's private artwork during login hydration.
    putData(empty);
    profileSync.current?.invalidate();
    const profileRead = profileSync.current!.beginBootstrap();
    clearDraftMedia();
    setSession({ ...result, user });
    setGuest(false);
    setError("");
    try {
      const bootstrap = await request<Bootstrap>(
        "/api/creator/bootstrap",
        result.access_token,
      );
      if (activeToken.current === result.access_token) {
        const profileIsCurrent =
          profileSync.current!.acceptBootstrap(
            profileRead,
            result.access_token,
          ) || profileOwnerToken.current !== result.access_token;
        profileOwnerToken.current = result.access_token;
        putData(
          profileIsCurrent
            ? bootstrap
            : { ...bootstrap, profile: dataRef.current.profile },
        );
      }
    } catch (e) {
      if (activeToken.current === result.access_token) {
        putData(
          !profileSync.current!.hasNewerThan(profileRead) ||
            profileOwnerToken.current !== result.access_token
            ? empty
            : { ...empty, profile: dataRef.current.profile },
        );
        setError((e as Error).message);
      }
    }
  }
  async function logout() {
    if (session) await api("/api/mobile/auth/logout", {});
    await forgetSession();
  }
  function enterGuest() {
    clearDraftMedia();
    setGuest(true);
    setError("");
    putData(previewData());
    setPreviewNetworks(emptyNetworkHub());
  }
  function savePreviewNetworks(hub: NetworkHub) {
    if (!guest || !demoEnabled) throw new Error("Sample mode is required.");
    setPreviewNetworks(hub);
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
        recordSavedItem,
        recordProfileImages,
        refreshProfileImages,
        preferences,
        toggle,
        savePreviewDraft,
        savePreviewFeed,
        previewNetworks,
        savePreviewNetworks,
      }}
    >
      {children}
    </Context.Provider>
  );
}
