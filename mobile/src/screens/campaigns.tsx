import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Crypto from "expo-crypto";
import {
  CalendarClock,
  CheckCircle2,
  Clapperboard,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
} from "lucide-react-native";
import { Action, Cover, Field, Notice, Pill } from "../components/ui";
import { MediaPlayer } from "../components/player";
import { useDesktopLayout } from "../components/desktop-layout";
import { useZiipa } from "../provider";
import { ApiError } from "../lib/api";
import {
  authorizationHeaders,
  portalMode,
  validateOrigin,
} from "../lib/config";
import { useOperationScope } from "../lib/use-operation-scope";
import { isoInstant } from "../lib/media-os-types";
import {
  campaignApprovalKey,
  campaignCanApprove,
  campaignArtifact,
  campaignFormats,
  campaignHasPublishedRendition,
  campaignLabel,
  campaignNeedsPolling,
  campaignPreviewItem,
  campaignPublishingSource,
  campaignRoot,
  campaignRenditions,
  campaignSegmentsText,
  destinationKey,
  parseCampaignSegments,
  type Campaign,
  type CampaignConfig,
  type CampaignConnection,
  type CampaignDestination,
  type CampaignPrivacy,
  type CampaignProvider,
  type CampaignRendition,
} from "../lib/campaign-types";
import type { MediaExport } from "../lib/share-types";
import type { Bootstrap, Item, RootStack, SocialProvider } from "../lib/types";
import { color, styles } from "../theme";

type Props = NativeStackScreenProps<RootStack, "Campaigns">;
type Draft = {
  name: string;
  title: string;
  description: string;
  destinations: CampaignDestination[];
  renditions: CampaignRendition[];
  ziipaRendition: CampaignRendition;
  schedule: string;
  rights: boolean;
  soundtrack: boolean;
  transcribe: boolean;
  transcriptionConsent: boolean;
  generateCopy: boolean;
  transcript: string;
  segments: string;
};
const blankDraft = (source?: Item): Draft => ({
  name: source?.title || "",
  title: (source?.title || "").slice(0, 100),
  description: source?.description || "",
  destinations: [],
  renditions: ["original"],
  ziipaRendition: "original",
  schedule: "",
  rights: false,
  soundtrack: false,
  transcribe: false,
  transcriptionConsent: false,
  generateCopy: false,
  transcript: "",
  segments: "",
});
function campaignDraft(campaign: Campaign): Draft {
  return {
    name: campaign.name,
    title: campaign.title,
    description: campaign.description,
    destinations: campaign.destinations.map((target) => ({
      ...target,
      rendition: target.rendition || "original",
    })),
    renditions: campaignRenditions(campaign),
    ziipaRendition: campaign.ziipa_rendition || "original",
    schedule: campaign.schedule_at || "",
    rights: campaign.rights_confirmed,
    soundtrack: campaign.soundtrack_rights_confirmed,
    transcribe: campaign.request_transcription,
    transcriptionConsent: campaign.transcription_consent,
    generateCopy: campaign.generate_copy || false,
    transcript: campaign.manual_transcript || "",
    segments: campaignSegmentsText(campaign.manual_segments || []),
  };
}
function panelTitle(value: string) {
  return campaignLabel(value || "Waiting");
}
function Block({
  step,
  title,
  children,
}: {
  step?: string;
  title: string;
  children: ReactNode;
}) {
  const { desktop } = useDesktopLayout();
  return (
    <View
      style={[
        styles.panel,
        { gap: 14 },
        desktop && { padding: 20, borderRadius: 12 },
      ]}
    >
      {step ? <Text style={styles.eyebrow}>{step}</Text> : null}
      <Text style={[styles.heading, desktop && { fontSize: 19 }]}>{title}</Text>
      {children}
    </View>
  );
}
function DesktopGroup({
  children,
  style,
}: {
  children: ReactNode;
  style: StyleProp<ViewStyle>;
}) {
  const { desktop } = useDesktopLayout();
  return desktop ? <View style={style}>{children}</View> : <>{children}</>;
}
function DesktopStep({
  index,
  active,
  children,
}: {
  index: number;
  active: number;
  children: ReactNode;
}) {
  const { desktop } = useDesktopLayout();
  return desktop && index !== active ? null : <>{children}</>;
}
const desktopSteps = [
  "Source",
  "Prepare",
  "Formats",
  "Destinations",
  "Review",
  "Progress",
];
function Consent({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={[styles.row, { opacity: disabled ? 0.55 : 1 }]}>
      <Switch
        accessibilityLabel={label}
        disabled={disabled}
        value={value}
        onValueChange={onChange}
        trackColor={{ true: color.purple }}
      />
      <Text style={[styles.small, { flex: 1 }]}>{label}</Text>
    </View>
  );
}
const names: Record<SocialProvider, string> = {
  bluesky: "Bluesky",
  youtube: "YouTube",
  facebook: "Facebook Pages",
  instagram: "Instagram",
  tiktok: "TikTok",
  twitch: "Twitch",
};
const noApproval = () => ({
  key: "",
  previewed: false,
  ziipa: false,
  destinations: [] as string[],
  reviewedRenditions: [] as CampaignRendition[],
});

export function CampaignsScreen(props: Props) {
  const { session } = useZiipa();
  return (
    <ScopedCampaignsScreen
      key={`${session?.access_token || "guest"}:${props.route.params?.itemId || ""}:${props.route.params?.campaignId || ""}`}
      {...props}
    />
  );
}

function ScopedCampaignsScreen({ route, navigation }: Props) {
  const { session, api, data, guest, forgetSession, refresh } = useZiipa();
  const { desktop, contentWidth } = useDesktopLayout();
  const [desktopStep, setDesktopStep] = useState(0);
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const active = focused && foreground;
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(
    route.params?.campaignId || null,
  );
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [sourceId, setSourceId] = useState(route.params?.itemId || "");
  const [config, setConfig] = useState<CampaignConfig | null>(null);
  const [providers, setProviders] = useState<CampaignProvider[]>([]);
  const [connections, setConnections] = useState<CampaignConnection[]>([]);
  const [storedDraft, setDraft] = useState<Draft>(() => blankDraft());
  const draft: Draft = {
    ...blankDraft(),
    ...storedDraft,
    renditions: storedDraft.renditions || ["original"],
    ziipaRendition: storedDraft.ziipaRendition || "original",
  };
  const [storedApproval, setApproval] = useState(noApproval);
  const approval = {
    ...noApproval(),
    ...storedApproval,
    reviewedRenditions: storedApproval.reviewedRenditions || [],
  };
  const [preview, setPreview] = useState<{
    key: string;
    item: Item;
    rendition: CampaignRendition;
  } | null>(null);
  const [captionsReviewed, setCaptionsReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const requestId = useRef(Crypto.randomUUID());
  const formVersion = useRef("");
  const actionFlight = useRef(false);
  const owner = useRef(session?.access_token);
  owner.current = session?.access_token;
  const requests = useRef(new Set<AbortController>());
  const capture = useOperationScope(
    `${session?.access_token}:${selectedId || "new"}`,
    active,
  );
  const sources = data.drafts.filter(
    (item) =>
      !item.demo &&
      item.creator_id === session?.user.id &&
      !!item.media_id &&
      item.content_type?.startsWith("video/") &&
      ["video", "music", "games"].includes(item.category) &&
      item.visibility !== "hidden",
  );
  const source = sources.find(
    (item) => item.id === (campaign?.item_id || sourceId),
  );
  const approvalKey = campaign ? campaignApprovalKey(campaign) : "";
  const dirty =
    !!campaign &&
    JSON.stringify(draft) !== JSON.stringify(campaignDraft(campaign));
  const attempted = !!campaign?.deliveries.some(
    (delivery) =>
      delivery.attempts > 0 ||
      ["sending", "processing", "delivered", "uncertain"].includes(
        delivery.status,
      ),
  );
  const editable =
    !busy &&
    !attempted &&
    !campaignHasPublishedRendition(campaign) &&
    !["cancelled", "completed", "partial"].includes(campaign?.status || "");
  const publishingSource = campaignPublishingSource(campaign, source?.id);

  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (!active) {
      requests.current.forEach((request) => request.abort());
      setApproval(noApproval());
      setPreview(null);
    }
    return () => {
      requests.current.forEach((request) => request.abort());
    };
  }, [active]);
  useEffect(() => {
    setBusy(false);
    setError("");
    setMessage("");
    setApproval(noApproval());
    setPreview(null);
  }, [selectedId]);
  useEffect(() => {
    if (!campaign) return;
    const version = `${campaign.id}:${campaign.revision}`;
    if (formVersion.current === version) return;
    formVersion.current = version;
    setDraft(campaignDraft(campaign));
    setApproval(noApproval());
    setPreview(null);
    setCaptionsReviewed(false);
    // Unsaved copy is preserved across same-revision progress refreshes.
  }, [campaign?.id, campaign?.revision]);
  useEffect(() => {
    setCaptionsReviewed(false);
  }, [campaign?.transcript_hash]);
  useEffect(() => {
    if (!selectedId) setDraft(blankDraft(source));
  }, [sourceId, selectedId, source?.id]);

  const patchCampaign = useCallback(
    async <T,>(path: string, body: unknown): Promise<T> => {
      const token = session?.access_token;
      if (
        !token ||
        owner.current !== token ||
        !/^\/api\/os\/campaigns\/[0-9a-f-]{36}$/.test(path)
      )
        throw new Error("Sign in and choose your saved campaign.");
      const controller = new AbortController();
      requests.current.add(controller);
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(validateOrigin() + path, {
          method: "PATCH",
          headers: {
            ...authorizationHeaders(token),
            "Content-Type": "application/json",
          },
          credentials: portalMode ? "include" : "omit",
          redirect: "error",
          signal: controller.signal,
          body: JSON.stringify(body),
        });
        const result = await response.json().catch(() => null);
        if (owner.current !== token)
          throw new Error("Your account changed. Reopen Campaigns.");
        if (!response.ok) {
          if (response.status === 401) await forgetSession();
          throw new ApiError(
            typeof result?.detail === "string"
              ? result.detail
              : "Could not save this campaign. Refresh its current revision and try again.",
            response.status,
          );
        }
        return result as T;
      } finally {
        clearTimeout(timer);
        requests.current.delete(controller);
      }
    },
    [session?.access_token, forgetSession],
  );

  const load = useCallback(async () => {
    if (!session || guest || !active) return;
    const valid = capture();
    setLoading(true);
    setError("");
    try {
      const [list, settings, publishing, grants] = await Promise.all([
        api<Campaign[]>(campaignRoot),
        api<CampaignConfig>(`${campaignRoot}/config`),
        api<{ providers: CampaignProvider[] }>("/api/publishing/config"),
        api<{ connections: CampaignConnection[] }>(
          "/api/publishing/connections",
        ),
      ]);
      if (!valid()) return;
      setCampaigns(list);
      setConfig(settings);
      setProviders(publishing.providers);
      setConnections(grants.connections);
      if (selectedId) {
        const detail = await api<Campaign>(`${campaignRoot}/${selectedId}`);
        if (valid()) setCampaign(detail);
      } else setCampaign(null);
    } catch (e) {
      if (valid())
        setError(e instanceof Error ? e.message : "Campaigns could not load.");
    } finally {
      if (valid()) setLoading(false);
    }
  }, [api, session?.access_token, guest, active, selectedId, capture]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!active || !selectedId || !campaignNeedsPolling(campaign)) return;
    let stopped = false;
    const poll = async () => {
      const valid = capture();
      try {
        const current = await api<Campaign>(`${campaignRoot}/${selectedId}`);
        if (!stopped && valid()) {
          setCampaign(current);
          setCampaigns((previous) =>
            previous.map((entry) =>
              entry.id === current.id ? current : entry,
            ),
          );
        }
      } catch (e) {
        if (!stopped && valid())
          setError(
            e instanceof Error ? e.message : "Progress could not refresh.",
          );
      }
      if (!stopped) timer = setTimeout(() => void poll(), 10000);
    };
    let timer = setTimeout(() => void poll(), 10000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, selectedId, campaign?.status, api, capture]);

  function change<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setApproval(noApproval());
    setPreview(null);
    setCaptionsReviewed(false);
    setMessage("");
  }
  async function run(work: (valid: () => boolean) => Promise<void>) {
    if (actionFlight.current || !active || !session || guest) return;
    actionFlight.current = true;
    const valid = capture();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work(valid);
    } catch (e) {
      if (valid()) {
        setApproval(noApproval());
        setPreview(null);
        setError(
          e instanceof Error
            ? e.message
            : "This campaign action could not complete.",
        );
      }
    } finally {
      actionFlight.current = false;
      if (valid()) setBusy(false);
    }
  }
  function input() {
    if (!draft.name.trim() || !draft.title.trim())
      throw new Error("Give the campaign and video a title.");
    if (!draft.rights)
      throw new Error(
        "Confirm your rights to the source media before preparing it.",
      );
    if (source?.soundtrack?.media_id && !draft.soundtrack)
      throw new Error("Confirm your selected soundtrack rights.");
    if (draft.transcribe && !draft.transcriptionConsent)
      throw new Error(
        "Approve private transcription processing or turn it off.",
      );
    return {
      name: draft.name.trim(),
      title: draft.title.trim(),
      description: draft.description,
      destinations: draft.destinations,
      renditions: draft.renditions,
      ziipa_rendition: draft.ziipaRendition,
      schedule_at: isoInstant(draft.schedule),
      rights_confirmed: draft.rights,
      soundtrack_rights_confirmed: draft.soundtrack,
      request_transcription: draft.transcribe,
      transcription_consent: draft.transcriptionConsent,
      generate_copy: draft.generateCopy,
      manual_transcript: draft.transcript,
      manual_segments: parseCampaignSegments(draft.segments),
    };
  }
  function remember(result: Campaign, preserveReview = false) {
    formVersion.current = `${result.id}:${result.revision}`;
    setCampaign(result);
    setDraft(campaignDraft(result));
    setCampaigns((previous) => [
      result,
      ...previous.filter((entry) => entry.id !== result.id),
    ]);
    setApproval((previous) =>
      preserveReview && previous.key === campaignApprovalKey(result)
        ? previous
        : {
            ...noApproval(),
            key: preserveReview ? campaignApprovalKey(result) : "",
          },
    );
    setPreview(null);
    setCaptionsReviewed(false);
  }
  async function save(valid: () => boolean) {
    if (!source)
      throw new Error("Choose one of your saved video uploads first.");
    const fields = input();
    const result = campaign
      ? await patchCampaign<Campaign>(`${campaignRoot}/${campaign.id}`, {
          revision: campaign.revision,
          ...fields,
        })
      : await api<Campaign>(campaignRoot, {
          request_id: requestId.current,
          item_id: source.id,
          ...fields,
        });
    if (!valid()) return;
    remember(result);
    setSelectedId(result.id);
    setMessage(
      "Campaign saved. Prepare the media, then review the actual export before approving delivery.",
    );
  }
  async function action(
    operation: "prepare" | "pause" | "resume" | "cancel",
    valid: () => boolean,
  ) {
    if (!campaign) return;
    const result = await api<Campaign>(
      `${campaignRoot}/${campaign.id}/${operation}`,
      { revision: campaign.revision },
    );
    if (valid()) {
      remember(result);
      setMessage(
        operation === "prepare"
          ? "Preparation requested. Follow the saved progress below."
          : `Campaign ${operation} requested. Check its saved status and delivery receipts.`,
      );
    }
  }
  async function review(
    valid: () => boolean,
    rendition: CampaignRendition = campaign?.ziipa_rendition || "original",
  ) {
    if (!campaign || !source || dirty)
      throw new Error(
        "Save your changes and prepare the current edit before review.",
      );
    const reviewed = await api<Campaign>(
      `${campaignRoot}/${campaign.id}/review`,
      { revision: campaign.revision },
    );
    if (!valid()) return;
    const info = await api<MediaExport>(
      `${campaignRoot}/${campaign.id}/preview?rendition=${rendition}`,
    );
    if (!valid()) return;
    const item = campaignPreviewItem(reviewed, source, info, rendition);
    remember(reviewed, true);
    const key = campaignApprovalKey(reviewed);
    setPreview({ key, item, rendition });
    setMessage(
      "Play each rendered format, check its copy and approve each destination below.",
    );
  }
  async function approve(valid: () => boolean) {
    if (
      !campaign ||
      !campaignCanApprove(campaign, approval, dirty) ||
      preview?.key !== approvalKey
    )
      throw new Error(
        "Review the current video and approve Ziipa plus every selected destination.",
      );
    const result = await api<Campaign>(
      `${campaignRoot}/${campaign.id}/approve`,
      {
        revision: campaign.revision,
        review_hash: campaign.review_hash,
        consent: true,
        publish_to_ziipa: true,
      },
    );
    if (valid()) {
      remember(result);
      setMessage(
        "Your exact reviewed plan is approved. Follow saved receipts to see what was actually delivered.",
      );
    }
  }
  function selectTarget(
    provider: CampaignProvider,
    connection?: CampaignConnection,
  ) {
    const target = connection?.targets.find(
      (target) => target.id === connection.selected_target_id,
    );
    if (!target) return;
    const existing = draft.destinations.some(
      (destination) => destination.provider === provider.provider,
    );
    change(
      "destinations",
      existing
        ? draft.destinations.filter(
            (destination) => destination.provider !== provider.provider,
          )
        : [
            ...draft.destinations,
            {
              provider: provider.provider,
              target_id: target.id,
              privacy: (provider.allowed_privacy?.find((privacy) =>
                ["private", "unlisted", "public"].includes(privacy),
              ) || "public") as CampaignPrivacy,
              made_for_kids: false,
              rendition: draft.ziipaRendition,
            },
          ],
    );
  }
  function toggleRendition(format: CampaignRendition) {
    if (!editable) return;
    if (draft.renditions.includes(format)) {
      if (
        draft.ziipaRendition === format ||
        draft.destinations.some(
          (target) => (target.rendition || "original") === format,
        )
      ) {
        setError(
          "Choose another format for Ziipa and any destination using this format before removing it.",
        );
        return;
      }
      change(
        "renditions",
        draft.renditions.filter((value) => value !== format),
      );
    } else change("renditions", [...draft.renditions, format]);
  }
  function targetName(destination: CampaignDestination) {
    return (
      connections
        .find((connection) => connection.provider === destination.provider)
        ?.targets.find((target) => target.id === destination.target_id)?.name ||
      destination.target_id
    );
  }
  function startNew() {
    setSelectedId(null);
    setCampaign(null);
    setSourceId("");
    setDraft(blankDraft());
    requestId.current = Crypto.randomUUID();
    setApproval(noApproval());
    setPreview(null);
  }

  if (!session || guest)
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.page}>
        <Block title="Create once. Review every destination.">
          <Text style={styles.body}>
            Bring your saved video through preparation, a real export preview
            and a delivery plan you control.
          </Text>
          <Notice text="Sign in to prepare and schedule your own media. Campaigns do not create sample deliveries." />
          <Action
            title="Sign in to Campaigns"
            onPress={() => navigation.navigate("Login")}
          />
        </Block>
      </ScrollView>
    );

  return (
    <ScrollView
      style={styles.screen}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[
        styles.page,
        {
          width: "100%",
          maxWidth: desktop ? 1480 : 950,
          alignSelf: "center",
          paddingBottom: 55,
        },
        desktop && { paddingHorizontal: 28, paddingTop: 24, gap: 20 },
      ]}
    >
      {desktop ? (
        <View
          style={[
            styles.between,
            { flexWrap: "wrap", alignItems: "flex-start", gap: 16 },
          ]}
        >
          <View style={{ flex: 1, minWidth: 220, gap: 5 }}>
            <Text style={[styles.heading, { fontSize: 25 }]}>Campaigns</Text>
            <Text style={styles.small}>
              Prepare, review and track each approved release.
            </Text>
          </View>
          <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]}>
            <Action
              secondary
              title="Release calendar"
              icon={CalendarClock}
              onPress={() =>
                navigation.navigate("Calendar", {
                  kind: "campaign",
                  campaignId: campaign?.id,
                })
              }
            />
            <Action
              title="New campaign"
              icon={Plus}
              disabled={busy}
              onPress={() => {
                setDesktopStep(0);
                startNew();
              }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh campaigns"
              disabled={busy || loading}
              onPress={() => void load()}
              style={{ padding: 10 }}
            >
              <RefreshCw size={18} color={color.muted} />
            </Pressable>
          </View>
        </View>
      ) : (
        <>
          <View style={styles.between}>
            <View style={{ flex: 1 }}>
              <Text style={styles.eyebrow}>ZIIPA CAMPAIGNS</Text>
              <Text style={styles.title}>Your next release.</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh campaigns"
              disabled={busy || loading}
              onPress={() => void load()}
              style={{ padding: 12 }}
            >
              <RefreshCw color={color.lime} size={24} />
            </Pressable>
          </View>
          <Text style={styles.body}>
            Prepare one saved video, review the finished edit, then follow
            delivery to your approved destinations.
          </Text>
          <Action
            secondary
            title="Open calendar and release reminders"
            icon={CalendarClock}
            onPress={() =>
              navigation.navigate("Calendar", {
                kind: "campaign",
                campaignId: campaign?.id,
              })
            }
          />
        </>
      )}
      {error ? <Notice text={error} error /> : null}
      {message ? <Notice text={message} /> : null}
      {loading ? (
        <View style={styles.row}>
          <ActivityIndicator color={color.lime} />
          <Text style={styles.small}>Loading your campaigns…</Text>
        </View>
      ) : null}
      {config?.enabled === false || config?.worker_ready === false ? (
        <Notice
          text={
            config.detail ||
            "Campaign processing is unavailable in this environment. Your saved plans remain available for review."
          }
        />
      ) : null}
      <DesktopGroup
        style={{
          flexDirection: contentWidth >= 760 ? "row" : "column",
          alignItems: "flex-start",
          gap: 22,
        }}
      >
        <DesktopGroup
          style={{
            width:
              contentWidth >= 760 ? (contentWidth >= 1200 ? 300 : 230) : "100%",
            gap: 12,
          }}
        >
          {desktop && (
            <View style={{ gap: 5, paddingBottom: 8 }}>
              <Text style={[styles.heading, { fontSize: 16 }]}>
                Your campaigns
              </Text>
              <Text style={styles.small}>
                {campaigns.length} saved{" "}
                {campaigns.length === 1 ? "plan" : "plans"}
              </Text>
            </View>
          )}
          <View style={{ gap: 9 }}>
            {!desktop && (
              <Action
                title="New campaign"
                icon={Plus}
                secondary
                disabled={busy}
                onPress={startNew}
              />
            )}
            {desktop && !campaigns.length && (
              <View
                style={[
                  styles.panel,
                  { padding: 16, borderRadius: 11, gap: 8 },
                ]}
              >
                <Send size={24} color="#AE8FD4" />
                <Text style={styles.label}>No campaigns yet</Text>
                <Text style={styles.small}>
                  Choose a saved video to prepare your first release. Publishing
                  always requires a separate review.
                </Text>
              </View>
            )}
            {campaigns.map((entry) => (
              <Pressable
                key={entry.id}
                accessibilityRole="button"
                accessibilityState={{
                  selected: selectedId === entry.id,
                  disabled: busy,
                }}
                disabled={busy}
                onPress={() => {
                  if (desktop) setDesktopStep(0);
                  if (selectedId === entry.id) {
                    void load();
                    return;
                  }
                  setCampaign(null);
                  setSelectedId(entry.id);
                }}
                style={[
                  styles.panel,
                  {
                    gap: 6,
                    padding: 14,
                    ...(desktop ? { padding: 12, borderRadius: 10 } : {}),
                    borderColor:
                      selectedId === entry.id ? color.lime : color.border,
                  },
                ]}
              >
                <View style={styles.between}>
                  <Text style={[styles.label, { flex: 1 }]}>{entry.name}</Text>
                  <Text style={[styles.small, { color: color.lime }]}>
                    {panelTitle(entry.status)}
                  </Text>
                </View>
                <Text style={styles.small}>{entry.detail}</Text>
              </Pressable>
            ))}
          </View>
        </DesktopGroup>
        <DesktopGroup style={{ flex: 1, minWidth: 0, width: "100%", gap: 18 }}>
          {desktop && (
            <View style={{ gap: 12 }}>
              <View
                style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}
                accessibilityRole="tablist"
              >
                {desktopSteps.map((title, index) => (
                  <Pressable
                    key={title}
                    accessibilityRole="tab"
                    accessibilityState={{
                      selected: desktopStep === index,
                      disabled: busy || (index >= 4 && !campaign),
                    }}
                    disabled={busy || (index >= 4 && !campaign)}
                    onPress={() => setDesktopStep(index)}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 7,
                      minHeight: 36,
                      paddingHorizontal: 11,
                      paddingVertical: 8,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor:
                        desktopStep === index ? "#73519B" : "#3C2C49",
                      backgroundColor:
                        desktopStep === index ? "#3E245A" : "#1C1426",
                      opacity: busy || (index >= 4 && !campaign) ? 0.45 : 1,
                    }}
                  >
                    <Text
                      style={[
                        styles.small,
                        {
                          fontSize: 10,
                          color: desktopStep === index ? color.lime : "#8F7C9F",
                        },
                      ]}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </Text>
                    <Text
                      style={[
                        styles.small,
                        {
                          color:
                            desktopStep === index ? color.text : color.muted,
                        },
                      ]}
                    >
                      {title}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {!campaign && (
                <Text style={styles.small}>
                  Save your plan in Destinations to unlock preparation review
                  and delivery receipts.
                </Text>
              )}
            </View>
          )}
          {selectedId && !campaign ? (
            <Notice text="Loading the selected campaign. Refresh if it cannot be reached." />
          ) : (
            <>
              <DesktopStep index={0} active={desktopStep}>
                <Block
                  step="01 / SOURCE"
                  title={campaign ? campaign.name : "Choose your saved video"}
                >
                  {campaign ? (
                    <>
                      <Text style={styles.label}>
                        Revision {campaign.revision} ·{" "}
                        {panelTitle(campaign.status)}
                      </Text>
                      <Text
                        accessibilityLiveRegion="polite"
                        style={styles.body}
                      >
                        {campaign.detail}
                      </Text>
                      {campaign.schedule_at ? (
                        <Text style={styles.small}>
                          Planned time:{" "}
                          {new Date(campaign.schedule_at).toLocaleString()} ·{" "}
                          {campaign.schedule_at}
                        </Text>
                      ) : null}
                    </>
                  ) : (
                    <>
                      {sources.length ? (
                        sources.map((item) => (
                          <Pressable
                            key={item.id}
                            accessibilityRole="radio"
                            accessibilityState={{
                              checked: sourceId === item.id,
                              disabled: busy,
                            }}
                            disabled={busy}
                            onPress={() => setSourceId(item.id)}
                            style={[
                              styles.row,
                              {
                                padding: 11,
                                borderWidth: 1,
                                borderRadius: 14,
                                borderColor:
                                  sourceId === item.id
                                    ? color.lime
                                    : color.border,
                              },
                            ]}
                          >
                            <Cover
                              item={item}
                              style={{
                                width: 62,
                                height: 76,
                                borderRadius: 10,
                              }}
                            />
                            <View style={{ flex: 1 }}>
                              <Text style={styles.label}>{item.title}</Text>
                              <Text style={styles.small}>
                                {item.visibility === "published"
                                  ? "Ziipa post"
                                  : "Private draft"}{" "}
                                · saved video
                              </Text>
                            </View>
                            {sourceId === item.id ? (
                              <CheckCircle2 color={color.lime} size={22} />
                            ) : null}
                          </Pressable>
                        ))
                      ) : (
                        <Notice text="Upload or record a video in Creator Studio and save it to your account to start." />
                      )}
                      <Action
                        title="Upload or record in Creator Studio"
                        secondary
                        onPress={() =>
                          navigation.navigate("Composer", { category: "video" })
                        }
                      />
                    </>
                  )}
                  {source ? (
                    <Text style={styles.small}>
                      Source: {source.title}. The campaign uses your saved trim,
                      captions, overlays and soundtrack.
                    </Text>
                  ) : campaign ? (
                    <Notice
                      text="The source video is unavailable in your current library. Refresh your account before preparing or approving this campaign."
                      error
                    />
                  ) : null}
                </Block>
              </DesktopStep>

              <DesktopStep index={1} active={desktopStep}>
                <Block
                  step="02 / PREPARE"
                  title="Copy, transcript and saved edit"
                >
                  {attempted ? (
                    <Notice text="A destination has already been attempted. This campaign's content is locked. Create a new campaign for another release; check uncertain receipts before posting again." />
                  ) : null}
                  <Field
                    label="Campaign name"
                    value={draft.name}
                    editable={editable}
                    maxLength={120}
                    onChangeText={(value) => change("name", value)}
                  />
                  <Field
                    label="Video title"
                    value={draft.title}
                    editable={editable}
                    maxLength={100}
                    onChangeText={(value) => change("title", value)}
                  />
                  <Field
                    label="Description / post copy"
                    value={draft.description}
                    editable={editable}
                    maxLength={3000}
                    multiline
                    onChangeText={(value) => change("description", value)}
                  />
                  <Consent
                    label="I own this media or have permission to publish it to these destinations."
                    value={draft.rights}
                    disabled={!editable}
                    onChange={(value) => change("rights", value)}
                  />
                  {source?.soundtrack?.media_id ? (
                    <Consent
                      label="I own or have a license to use the saved soundtrack."
                      value={draft.soundtrack}
                      disabled={!editable}
                      onChange={(value) => change("soundtrack", value)}
                    />
                  ) : null}
                  <Consent
                    label="Request a private transcript from this video"
                    value={draft.transcribe}
                    disabled={!editable}
                    onChange={(value) => change("transcribe", value)}
                  />
                  {draft.transcribe ? (
                    <Consent
                      label="Allow the configured private transcription worker to process this source."
                      value={draft.transcriptionConsent}
                      disabled={!editable}
                      onChange={(value) =>
                        change("transcriptionConsent", value)
                      }
                    />
                  ) : null}
                  <Consent
                    label="Suggest title and description copy with the private model"
                    value={draft.generateCopy}
                    disabled={!editable}
                    onChange={(value) => change("generateCopy", value)}
                  />
                  {campaign?.transcript ? (
                    <View style={{ gap: 8 }}>
                      <Text style={styles.label}>
                        Transcript · {panelTitle(campaign.transcript.status)}
                      </Text>
                      <Text style={styles.small}>
                        {campaign.transcript.detail}
                      </Text>
                      {campaign.transcript.text ? (
                        <Text selectable style={styles.body}>
                          {campaign.transcript.text}
                        </Text>
                      ) : null}
                      {campaign.transcript.segments?.length ? (
                        <Text selectable style={styles.small}>
                          {campaignSegmentsText(campaign.transcript.segments)}
                        </Text>
                      ) : null}
                      {editable && campaign.transcript.text ? (
                        <Action
                          secondary
                          title="Copy transcript into corrections"
                          onPress={() => {
                            change("transcript", campaign.transcript.text);
                            change(
                              "segments",
                              campaignSegmentsText(
                                campaign.transcript.segments || [],
                              ),
                            );
                          }}
                        />
                      ) : null}
                      {campaign.transcript.segments?.length &&
                      campaign.transcript_hash ? (
                        <>
                          <Consent
                            label="I reviewed these exact caption words and timestamps for my video."
                            value={captionsReviewed}
                            disabled={!editable || dirty}
                            onChange={setCaptionsReviewed}
                          />
                          <Action
                            secondary
                            title="Apply reviewed captions and prepare again"
                            icon={Clapperboard}
                            disabled={!editable || dirty || !captionsReviewed}
                            busy={busy}
                            onPress={() =>
                              void run(async (valid) => {
                                const result = await api<Campaign>(
                                  `${campaignRoot}/${campaign.id}/apply-captions`,
                                  {
                                    revision: campaign.revision,
                                    transcript_hash: campaign.transcript_hash,
                                  },
                                );
                                if (!valid()) return;
                                remember(result);
                                await refresh();
                                if (valid())
                                  setMessage(
                                    "Reviewed captions saved to your source edit. A new render must be reviewed before delivery.",
                                  );
                              })
                            }
                          />
                        </>
                      ) : null}
                    </View>
                  ) : null}
                  {campaign?.generated_copy?.detail ? (
                    <Notice text={campaign.generated_copy.detail} />
                  ) : null}
                  {campaign?.generated_copy?.status === "ready" &&
                  (campaign.generated_copy.title ||
                    campaign.generated_copy.description) ? (
                    <View style={{ gap: 8 }}>
                      <Text style={styles.label}>
                        Suggested copy · review before using
                      </Text>
                      {campaign.generated_copy.title ? (
                        <Text style={styles.body}>
                          {campaign.generated_copy.title}
                        </Text>
                      ) : null}
                      {campaign.generated_copy.description ? (
                        <Text style={styles.small}>
                          {campaign.generated_copy.description}
                        </Text>
                      ) : null}
                      <Action
                        secondary
                        title="Use suggested copy in my draft"
                        disabled={!editable}
                        onPress={() => {
                          if (campaign.generated_copy?.title)
                            change(
                              "title",
                              campaign.generated_copy.title.slice(0, 100),
                            );
                          if (campaign.generated_copy?.description)
                            change(
                              "description",
                              campaign.generated_copy.description.slice(
                                0,
                                3000,
                              ),
                            );
                        }}
                      />
                    </View>
                  ) : null}
                  <Field
                    label="Transcript corrections / manual transcript"
                    value={draft.transcript}
                    multiline
                    maxLength={12000}
                    editable={editable}
                    onChangeText={(value) => change("transcript", value)}
                  />
                  <Field
                    label="Timed transcript notes · seconds: start --> end | text"
                    value={draft.segments}
                    multiline
                    maxLength={30000}
                    editable={editable}
                    placeholder="0 --> 4.5 | Corrected words"
                    onChangeText={(value) => change("segments", value)}
                  />
                  <Text style={styles.small}>
                    Save transcript corrections and prepare to refresh the
                    reviewed cues. Captions change only when you choose Apply
                    reviewed captions. You can also edit them in Creator Studio,
                    then prepare again.
                  </Text>
                  {source ? (
                    <Action
                      secondary
                      title="Edit source video and captions"
                      disabled={busy}
                      onPress={() =>
                        navigation.navigate("Composer", { item: source })
                      }
                    />
                  ) : null}
                </Block>
              </DesktopStep>

              <DesktopStep index={2} active={desktopStep}>
                <Block step="03 / FORMATS" title="Make the right version">
                  <Text style={styles.small}>
                    Generate real MP4s from the same saved edit. Portrait,
                    square and landscape fit the whole image with padding, so
                    important details are not cropped. Every selected version
                    must be played and reviewed before approval.
                  </Text>
                  {campaignFormats.map((format) => (
                    <Consent
                      key={format.id}
                      label={`${format.title} · ${format.detail}`}
                      value={draft.renditions.includes(format.id)}
                      disabled={!editable}
                      onChange={() => toggleRendition(format.id)}
                    />
                  ))}
                  <Text style={styles.label}>
                    Format for the Ziipa profile post
                  </Text>
                  <View
                    style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
                  >
                    {draft.renditions.map((format) => (
                      <Pill
                        key={format}
                        title={
                          campaignFormats.find((value) => value.id === format)
                            ?.title || format
                        }
                        active={draft.ziipaRendition === format}
                        onPress={() => {
                          if (editable) change("ziipaRendition", format);
                        }}
                      />
                    ))}
                  </View>
                  {campaign
                    ? campaignRenditions(campaign).map((format) => (
                        <Text key={format} style={styles.small}>
                          {campaignLabel(format)}:{" "}
                          {campaignArtifact(campaign, format)
                            ? "Rendered artifact ready"
                            : campaign.render_jobs?.[format]
                              ? "Render submitted; follow preparation progress"
                              : "Not prepared"}
                        </Text>
                      ))
                    : null}
                </Block>
              </DesktopStep>

              <DesktopStep index={3} active={desktopStep}>
                <Block step="04 / DESTINATIONS" title="Choose where it goes">
                  <Notice text="Ziipa is included when you approve delivery. Other networks need a connected account, platform permissions and an approved target. A connected account alone does not publish anything." />
                  {providers.map((provider) => {
                    const connection = connections.find(
                      (value) => value.provider === provider.provider,
                    );
                    const target = connection?.targets.find(
                      (value) => value.id === connection.selected_target_id,
                    );
                    const destination = draft.destinations.find(
                      (value) => value.provider === provider.provider,
                    );
                    const handoff =
                      provider.provider === "tiktok" ||
                      provider.provider === "twitch";
                    const privacyOptions = (
                      provider.allowed_privacy || []
                    ).filter((value) =>
                      ["private", "unlisted", "public"].includes(value),
                    );
                    const readiness = [
                      ...(provider.requirements || []),
                      ...(provider.delivery_requirements || []),
                    ];
                    return (
                      <View
                        key={provider.provider}
                        style={{
                          gap: 9,
                          borderWidth: 1,
                          borderRadius: 15,
                          borderColor: destination ? color.lime : color.border,
                          padding: 14,
                        }}
                      >
                        <Text style={styles.label}>{provider.name}</Text>
                        <Text style={styles.small}>
                          {target
                            ? `Selected account: ${target.name}`
                            : "Choose and authorize an account in Publishing."}
                        </Text>
                        {handoff ? (
                          <Notice
                            text={
                              provider.provider === "twitch"
                                ? "Twitch requires the live broadcast workflow. A finished MP4 cannot be uploaded through its API."
                                : "TikTok requires its current creator options and an individual publishing review. This campaign provides a handoff."
                            }
                          />
                        ) : null}
                        {readiness.length ? (
                          <Text style={styles.small}>
                            {readiness.join("\n")}
                          </Text>
                        ) : null}
                        <Action
                          secondary
                          title={
                            destination
                              ? "Remove destination"
                              : target
                                ? `Add ${target.name}`
                                : "Connect and choose an account"
                          }
                          disabled={!editable}
                          onPress={() =>
                            target
                              ? selectTarget(provider, connection)
                              : navigation.navigate(
                                  "Publishing",
                                  publishingSource,
                                )
                          }
                        />
                        {destination ? (
                          <>
                            <Text style={styles.small}>
                              Video format for this destination
                            </Text>
                            <View
                              style={{
                                flexDirection: "row",
                                gap: 8,
                                flexWrap: "wrap",
                              }}
                            >
                              {draft.renditions.map((format) => (
                                <Pill
                                  key={format}
                                  title={
                                    campaignFormats.find(
                                      (value) => value.id === format,
                                    )?.title || format
                                  }
                                  active={
                                    (destination.rendition || "original") ===
                                    format
                                  }
                                  onPress={() => {
                                    if (editable)
                                      change(
                                        "destinations",
                                        draft.destinations.map((entry) =>
                                          entry.provider ===
                                          destination.provider
                                            ? { ...entry, rendition: format }
                                            : entry,
                                        ),
                                      );
                                  }}
                                />
                              ))}
                            </View>
                            <Text style={styles.small}>
                              Visibility for {targetName(destination)}
                            </Text>
                            <View
                              style={{
                                flexDirection: "row",
                                gap: 8,
                                flexWrap: "wrap",
                              }}
                            >
                              {(privacyOptions.length
                                ? privacyOptions
                                : [destination.privacy]
                              ).map((privacy) => (
                                <Pill
                                  key={privacy}
                                  title={campaignLabel(privacy)}
                                  active={destination.privacy === privacy}
                                  onPress={() => {
                                    if (editable)
                                      change(
                                        "destinations",
                                        draft.destinations.map((value) =>
                                          value.provider === provider.provider
                                            ? {
                                                ...value,
                                                privacy:
                                                  privacy as CampaignPrivacy,
                                              }
                                            : value,
                                        ),
                                      );
                                  }}
                                />
                              ))}
                            </View>
                            {provider.provider === "youtube" ? (
                              <Consent
                                label="This YouTube video is made for kids"
                                disabled={!editable}
                                value={destination.made_for_kids}
                                onChange={(value) =>
                                  change(
                                    "destinations",
                                    draft.destinations.map((entry) =>
                                      entry.provider === "youtube"
                                        ? { ...entry, made_for_kids: value }
                                        : entry,
                                    ),
                                  )
                                }
                              />
                            ) : null}
                          </>
                        ) : null}
                      </View>
                    );
                  })}
                  {!providers.length ? (
                    <Notice text="Provider capabilities could not load. You can keep this campaign for Ziipa and refresh before choosing other destinations." />
                  ) : null}
                  <Action
                    secondary
                    title="Manage network authorizations"
                    disabled={busy}
                    onPress={() =>
                      navigation.navigate("Publishing", publishingSource)
                    }
                  />
                  <Field
                    label="Delivery date and time · include timezone"
                    value={draft.schedule}
                    editable={editable}
                    placeholder="2026-10-20T18:00:00-04:00"
                    onChangeText={(value) => change("schedule", value)}
                  />
                  <Text style={styles.small}>
                    This time applies to Ziipa and the selected supported
                    destinations. Use Z for UTC or your timezone offset.
                  </Text>
                  <Action
                    secondary
                    title="Use current time · deliver after approval"
                    icon={CalendarClock}
                    disabled={!editable}
                    onPress={() => change("schedule", new Date().toISOString())}
                  />
                  <Action
                    title={campaign ? "Save plan changes" : "Save campaign"}
                    icon={Plus}
                    busy={busy}
                    disabled={!editable || !source || (!!campaign && !dirty)}
                    onPress={() => void run(save)}
                  />
                  {dirty ? (
                    <Notice text="You have unsaved changes. Save this plan, then prepare and review it again. Previous approvals do not cover these edits." />
                  ) : null}
                </Block>
              </DesktopStep>

              {campaign ? (
                <>
                  <DesktopStep index={4} active={desktopStep}>
                    <Block
                      step="05 / REVIEW & APPROVE"
                      title="Watch the finished edit"
                    >
                      <Text style={styles.small}>
                        Each preview is the actual rendered MP4 with your saved
                        trim, captions, overlays and soundtrack. Watch every
                        selected format. Changing a format or destination
                        requires saving, preparing and approving the new plan.
                      </Text>
                      <Action
                        title="Prepare video and requested transcript"
                        icon={Clapperboard}
                        busy={busy}
                        disabled={
                          dirty ||
                          !source ||
                          attempted ||
                          campaignHasPublishedRendition(campaign) ||
                          config?.can_prepare === false ||
                          campaign.status === "cancelled"
                        }
                        onPress={() =>
                          void run((valid) => action("prepare", valid))
                        }
                      />
                      <Text style={styles.small}>
                        Export:{" "}
                        {campaign.artifact
                          ? "Artifact available"
                          : campaign.render_job_id
                            ? "Follow preparation status above"
                            : "Not prepared"}
                      </Text>
                      {campaignRenditions(campaign).map((format) => (
                        <Action
                          key={format}
                          secondary
                          title={`Preview ${campaignFormats.find((value) => value.id === format)?.title || format}${approval.reviewedRenditions.includes(format) && approval.key === approvalKey ? " · reviewed" : ""}`}
                          icon={Clapperboard}
                          busy={busy}
                          disabled={
                            dirty ||
                            !source ||
                            !campaignArtifact(campaign, format) ||
                            !!campaign.approved_at ||
                            campaignHasPublishedRendition(campaign) ||
                            campaign.status !== "review"
                          }
                          onPress={() =>
                            void run((valid) => review(valid, format))
                          }
                        />
                      ))}
                      {preview?.key === approvalKey && !dirty ? (
                        <Text style={styles.label}>
                          Previewing {campaignLabel(preview.rendition)}
                        </Text>
                      ) : null}
                      {preview?.key === approvalKey && !dirty ? (
                        <MediaPlayer key={preview.key} item={preview.item} />
                      ) : null}
                      {campaign.artifact ? (
                        <Action
                          secondary
                          title="Open export downloads"
                          onPress={() =>
                            navigation.navigate("Exports", {
                              itemId: campaign.item_id,
                            })
                          }
                        />
                      ) : null}
                      {preview?.key === approvalKey && !dirty ? (
                        <>
                          <Text style={styles.label}>
                            Review revision {campaign.revision}
                          </Text>
                          <Text style={styles.body}>{campaign.title}</Text>
                          <Text style={styles.small}>
                            {campaign.description}
                          </Text>
                          <Text style={styles.small}>
                            Delivery time:{" "}
                            {campaign.schedule_at
                              ? new Date(campaign.schedule_at).toLocaleString()
                              : "Choose and save a time first"}
                          </Text>
                          <Consent
                            label={`I played and reviewed the ${preview.rendition} video, its framing and the title and description.`}
                            value={approval.reviewedRenditions.includes(
                              preview.rendition,
                            )}
                            disabled={busy}
                            onChange={(value) =>
                              setApproval((current) => {
                                const reviewedRenditions = value
                                  ? [
                                      ...new Set([
                                        ...(current.reviewedRenditions || []),
                                        preview.rendition,
                                      ]),
                                    ]
                                  : (current.reviewedRenditions || []).filter(
                                      (format) => format !== preview.rendition,
                                    );
                                return {
                                  ...current,
                                  reviewedRenditions,
                                  previewed: campaignRenditions(campaign).every(
                                    (format) =>
                                      reviewedRenditions.includes(format),
                                  ),
                                };
                              })
                            }
                          />
                          <Consent
                            label="I approve a separate rendered video post on my Ziipa profile at the saved time. My source draft stays private; an existing source post stays unchanged."
                            value={approval.ziipa}
                            disabled={busy}
                            onChange={(value) =>
                              setApproval((current) => ({
                                ...current,
                                ziipa: value,
                              }))
                            }
                          />
                          {campaign.destinations.map((destination) => {
                            const key = destinationKey(destination);
                            return (
                              <Consent
                                key={key}
                                label={`I approve ${names[destination.provider]} · ${targetName(destination)} · ${destination.privacy} · ${destination.rendition || "original"} format at this saved time${destination.provider === "tiktok" || destination.provider === "twitch" ? "; final delivery requires a separate handoff" : ""}.`}
                                value={approval.destinations.includes(key)}
                                disabled={busy}
                                onChange={(value) =>
                                  setApproval((current) => ({
                                    ...current,
                                    destinations: value
                                      ? [...current.destinations, key]
                                      : current.destinations.filter(
                                          (entry) => entry !== key,
                                        ),
                                  }))
                                }
                              />
                            );
                          })}
                          {config?.background_publishing_ready === false ? (
                            <Notice text="This worker has no configured external publishing providers. A Ziipa-only campaign can still run. External destinations remain blocked or require a separate handoff until their setup is complete." />
                          ) : null}
                          <Action
                            title="Approve this exact delivery plan"
                            icon={ShieldCheck}
                            busy={busy}
                            disabled={
                              !campaignCanApprove(campaign, approval, dirty) ||
                              config?.can_prepare === false
                            }
                            onPress={() => void run(approve)}
                          />
                        </>
                      ) : null}
                      {campaign.approved_at ? (
                        <Notice
                          text={`This revision was approved ${new Date(campaign.approved_at).toLocaleString()}. Delivery receipts below are the source of truth.`}
                        />
                      ) : null}
                    </Block>
                  </DesktopStep>
                  <DesktopStep index={5} active={desktopStep}>
                    <Block step="06 / PROGRESS" title="Delivery receipts">
                      <Text
                        accessibilityLiveRegion="polite"
                        style={styles.label}
                      >
                        {panelTitle(campaign.status)}
                      </Text>
                      <Text style={styles.body}>{campaign.detail}</Text>
                      <View
                        style={{
                          gap: 7,
                          padding: 14,
                          borderWidth: 1,
                          borderColor: color.border,
                          borderRadius: 14,
                        }}
                      >
                        <Text style={styles.label}>
                          Ziipa profile ·{" "}
                          {campaign.ziipa_published_at
                            ? "Published"
                            : "Not confirmed published"}
                        </Text>
                        <Text style={styles.small}>
                          {campaign.ziipa_published_at
                            ? `Published ${new Date(campaign.ziipa_published_at).toLocaleString()}`
                            : "Approval authorizes a separate post of the reviewed MP4 at the saved time. Your original Studio item is preserved. This receipt changes only after the worker confirms the new post."}
                        </Text>
                        {campaign.published_item_id ? (
                          <Action
                            secondary
                            title="View the published rendered Ziipa post"
                            onPress={() =>
                              void run(async (valid) => {
                                await refresh();
                                if (valid())
                                  navigation.navigate("Watch", {
                                    itemId: campaign.published_item_id!,
                                    category: source?.category,
                                  });
                              })
                            }
                          />
                        ) : null}
                      </View>
                      {campaign.deliveries.length ? (
                        campaign.deliveries.map((delivery) => (
                          <View
                            key={delivery.id}
                            style={{
                              gap: 7,
                              padding: 14,
                              borderWidth: 1,
                              borderColor: color.border,
                              borderRadius: 14,
                            }}
                          >
                            <View style={styles.between}>
                              <Text style={styles.label}>
                                {campaignLabel(delivery.provider)}
                              </Text>
                              <Text
                                style={[
                                  styles.small,
                                  {
                                    color:
                                      delivery.status === "delivered"
                                        ? color.lime
                                        : color.muted,
                                  },
                                ]}
                              >
                                {panelTitle(delivery.status)}
                              </Text>
                            </View>
                            <Text style={styles.small}>{delivery.detail}</Text>
                            <Text style={styles.small}>
                              Target: {delivery.target_id} · {delivery.privacy}{" "}
                              ·{delivery.rendition || "original"} format ·
                              attempts {delivery.attempts}
                            </Text>
                            {delivery.provider === "tiktok" &&
                            delivery.status === "needs_handoff" &&
                            (delivery.rendition || "original") !==
                              (campaign.ziipa_rendition || "original") ? (
                              <>
                                <Notice text="This TikTok format is a private owned rendition draft. Review and explicitly publish that draft in Creator Studio first, then complete TikTok's fresh creator, audience and source review in Publishing. Ziipa does not bypass this step." />
                                <Action
                                  secondary
                                  title="Review private TikTok rendition in Studio"
                                  disabled={!delivery.published_item_id}
                                  onPress={() =>
                                    void run(async (valid) => {
                                      const current = await api<Bootstrap>(
                                        "/api/creator/bootstrap",
                                      );
                                      if (!valid()) return;
                                      const rendition = current.drafts.find(
                                        (item) =>
                                          item.id ===
                                            delivery.published_item_id &&
                                          item.creator_id === session.user.id &&
                                          !item.demo,
                                      );
                                      if (!rendition)
                                        throw new Error(
                                          "The owned rendition draft is unavailable. Refresh its campaign receipts.",
                                        );
                                      navigation.navigate("Composer", {
                                        item: rendition,
                                      });
                                    })
                                  }
                                />
                              </>
                            ) : null}
                            {delivery.status === "uncertain" ? (
                              <Notice
                                error
                                text="Delivery is unconfirmed. Check this provider and its Publishing receipt before making another attempt. Ziipa will not assume a timeout means nothing was posted."
                              />
                            ) : null}
                            {delivery.status === "needs_handoff" ||
                            delivery.status === "blocked" ||
                            delivery.status === "uncertain" ||
                            delivery.status === "failed" ? (
                              <Action
                                secondary
                                title={
                                  delivery.provider === "twitch"
                                    ? "Open live broadcast controls"
                                    : "Review provider setup and publishing receipts"
                                }
                                icon={Send}
                                onPress={() =>
                                  delivery.provider === "twitch"
                                    ? navigation.navigate("Live", {
                                        tab: "broadcast",
                                      })
                                    : navigation.navigate(
                                        "Publishing",
                                        delivery.published_item_id
                                          ? {
                                              itemId:
                                                delivery.published_item_id,
                                            }
                                          : campaignPublishingSource(
                                              campaign,
                                              source?.id,
                                              delivery.rendition,
                                            ),
                                      )
                                }
                              />
                            ) : null}
                            {delivery.external_url ? (
                              <Action
                                secondary
                                title={
                                  delivery.status === "delivered"
                                    ? "Open verified external post"
                                    : "Open provider receipt link"
                                }
                                onPress={() =>
                                  void run(async () => {
                                    const url = new URL(delivery.external_url!);
                                    if (
                                      url.protocol !== "https:" ||
                                      url.username ||
                                      url.password
                                    )
                                      throw new Error(
                                        "This receipt has no safe external post URL.",
                                      );
                                    await Linking.openURL(url.href);
                                  })
                                }
                              />
                            ) : null}
                          </View>
                        ))
                      ) : (
                        <Text style={styles.small}>
                          No external delivery has been attempted. Ziipa and
                          provider progress appears here after approval.
                        </Text>
                      )}
                      {!["completed", "cancelled"].includes(campaign.status) ? (
                        <>
                          <Action
                            secondary
                            title={
                              campaign.status === "paused"
                                ? "Resume approved campaign"
                                : "Pause campaign"
                            }
                            busy={busy}
                            onPress={() =>
                              void run((valid) =>
                                action(
                                  campaign.status === "paused"
                                    ? "resume"
                                    : "pause",
                                  valid,
                                ),
                              )
                            }
                          />
                          <Text style={styles.small}>
                            Pausing prevents future work when the worker next
                            checks the plan. A request already sent to a
                            provider may still complete. Cancelling does not
                            remove posts already delivered.
                          </Text>
                          <Action
                            danger
                            title="Cancel future campaign work"
                            busy={busy}
                            onPress={() =>
                              void run((valid) => action("cancel", valid))
                            }
                          />
                        </>
                      ) : null}
                    </Block>
                  </DesktopStep>
                </>
              ) : null}
            </>
          )}
          {desktop && (
            <View
              style={[
                styles.between,
                {
                  borderTopWidth: 1,
                  borderColor: color.border,
                  paddingTop: 15,
                  gap: 12,
                },
              ]}
            >
              <Text style={styles.small}>
                Step {desktopStep + 1} of 6 · navigation does not save or
                deliver
              </Text>
              <View style={[styles.row, { gap: 8 }]}>
                {desktopStep > 0 && (
                  <Action
                    secondary
                    title="Previous"
                    disabled={busy}
                    onPress={() => setDesktopStep((index) => index - 1)}
                  />
                )}
                {desktopStep < 5 && (
                  <Action
                    secondary
                    title={`Next: ${desktopSteps[desktopStep + 1]}`}
                    disabled={busy || (desktopStep >= 3 && !campaign)}
                    onPress={() => setDesktopStep((index) => index + 1)}
                  />
                )}
              </View>
            </View>
          )}
        </DesktopGroup>
      </DesktopGroup>
    </ScrollView>
  );
}
