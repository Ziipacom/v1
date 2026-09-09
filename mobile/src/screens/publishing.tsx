import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Linking,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
} from "react-native";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Crypto from "expo-crypto";
import {
  CheckCircle2,
  RefreshCw,
  Send,
  ShieldCheck,
} from "lucide-react-native";
import { Action, Field, Notice } from "../components/ui";
import { MediaPlayer } from "../components/player";
import { useZiipa } from "../provider";
import type { Item, RootStack, SocialProvider } from "../lib/types";
import { color, styles } from "../theme";
import { readyRender, type RenderJob } from "../lib/render-types";
import { TwitchChannel } from "../components/twitch-channel";
import { useOperationScope } from "../lib/use-operation-scope";
import {
  blankTikTok,
  validateTikTokReview,
  tikTokReviewComplete,
  type TikTokChoices,
  type TikTokCreatorOptions,
  type TikTokReview,
} from "../lib/tiktok-review";

type Provider = {
  provider: SocialProvider;
  name: string;
  configured: boolean;
  publish_implemented: boolean;
  live_implemented?: boolean;
  requirements: string[];
  delivery_requirements?: string[];
  allowed_privacy?: string[];
  detail: string;
};
type Connection = {
  provider: SocialProvider;
  status: string;
  targets: { id: string; name: string; kind: string }[];
  selected_target_id: string | null;
  can_publish: boolean;
};
type Receipt = {
  id: string;
  item_id: string;
  provider: string;
  status: string;
  detail: string;
  external_url: string;
  created_at: string;
};
function Choice({
  title,
  active,
  onPress,
  disabled = false,
}: {
  title: string;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.panel,
        {
          padding: 12,
          borderColor: active ? color.lime : color.border,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      <Text style={styles.label}>
        {active ? "● " : "○ "}
        {title}
      </Text>
    </Pressable>
  );
}
function Consent({
  title,
  value,
  onChange,
  disabled = false,
}: {
  title: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={[styles.row, { opacity: disabled ? 0.45 : 1 }]}>
      <Switch
        disabled={disabled}
        accessibilityLabel={title}
        value={value}
        onValueChange={onChange}
        trackColor={{ true: color.purple }}
      />
      <Text style={[styles.small, { flex: 1 }]}>{title}</Text>
    </View>
  );
}
function Checkbox({
  title,
  value,
  onChange,
  disabled = false,
}: {
  title: string;
  value: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={title}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={[
        styles.row,
        { paddingVertical: 10, opacity: disabled ? 0.45 : 1 },
      ]}
    >
      <View
        style={{
          width: 24,
          height: 24,
          borderWidth: 1,
          borderColor: value ? color.lime : color.muted,
          borderRadius: 5,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: color.lime }}>{value ? "✓" : ""}</Text>
      </View>
      <Text style={[styles.small, { flex: 1 }]}>{title}</Text>
    </Pressable>
  );
}
const privacyLabels: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

export function PublishingScreen(
  props: NativeStackScreenProps<RootStack, "Publishing">,
) {
  const { session } = useZiipa();
  return (
    <ScopedPublishingScreen
      key={`${session?.access_token || "guest"}:${props.route.params?.itemId || ""}:${props.route.params?.renderId || ""}`}
      {...props}
    />
  );
}

function ScopedPublishingScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStack, "Publishing">) {
  const { api, guest, data, session } = useZiipa();
  const focused = useIsFocused();
  const inFlight = useRef(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [jobs, setJobs] = useState<Receipt[]>([]);
  const [provider, setProvider] = useState<SocialProvider>("youtube");
  const [itemId, setItemId] = useState(route.params?.itemId || "");
  const [privacy, setPrivacy] = useState<"private" | "unlisted" | "public">(
    "private",
  );
  const [madeForKids, setMadeForKids] = useState<boolean | null>(null);
  const [consent, setConsent] = useState(false);
  const [original, setOriginal] = useState(false);
  const [source, setSource] = useState<"rendered" | "original">("rendered");
  const [renderedId, setRenderedId] = useState(route.params?.renderId || "");
  const [renders, setRenders] = useState<RenderJob[]>([]);
  const [blueskyHandle, setBlueskyHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [requestId, setRequestId] = useState(() => Crypto.randomUUID());
  const [submitted, setSubmitted] = useState(false);
  const [tiktok, setTikTok] = useState<TikTokChoices>(blankTikTok);
  const [postTitle, setPostTitle] = useState(
    () =>
      data.drafts.find((item) => item.id === route.params?.itemId)?.title || "",
  );
  const [postDescription, setPostDescription] = useState(
    () =>
      data.drafts.find((item) => item.id === route.params?.itemId)
        ?.description || "",
  );
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const [reviewRecord, setReviewRecord] = useState<{
    key: string;
    creator: TikTokCreatorOptions;
    source: TikTokReview | null;
  } | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [reviewVersion, setReviewVersion] = useState(0);
  const [privacyExpanded, setPrivacyExpanded] = useState(false);
  const selected = connections.find((c) => c.provider === provider);
  const ready = providers.find((p) => p.provider === provider);
  const ownMedia = data.drafts.filter(
    (item) =>
      !item.demo &&
      item.media_id &&
      item.visibility === "published" &&
      item.creator_id === session?.user.id,
  );
  const currentItem = ownMedia.find((item) => item.id === itemId);
  const currentRender = renders.find(
    (job) => job.id === renderedId && readyRender(job, itemId),
  );
  const reviewScope = JSON.stringify([
    provider,
    selected?.status,
    selected?.selected_target_id,
    currentItem,
    source,
    renderedId,
    currentRender,
    reviewVersion,
  ]);
  const currentReview =
    focused && foreground && reviewRecord?.key === reviewScope
      ? reviewRecord
      : null;
  const creator = currentReview?.creator || null;
  const sourceReview = currentReview?.source || null;
  const previewItem: Item | null =
    currentItem && sourceReview
      ? {
          ...currentItem,
          media_url: `/api/creator/media/${sourceReview.media_id}`,
          media_id: sourceReview.media_id,
          content_type:
            source === "rendered" ? "video/mp4" : currentItem.content_type,
          demo: false,
          trim_start: 0,
          trim_end: null,
          captions: [],
          overlays: [],
          soundtrack: null,
        }
      : null;
  const approvalScope = JSON.stringify([
    provider,
    selected?.status,
    selected?.selected_target_id,
    currentItem,
    source,
    renderedId,
    privacy,
    madeForKids,
    tiktok,
    blueskyHandle,
    postTitle,
    postDescription,
    sourceReview?.source_sha256,
  ]);
  const capture = useOperationScope(approvalScope, focused);
  useEffect(() => {
    setConsent(false);
    setOriginal(false);
    setSubmitted(false);
    setRequestId(Crypto.randomUUID());
    setAuthUrl("");
    setBusy(false);
  }, [approvalScope]);
  useEffect(() => {
    setTikTok(blankTikTok);
  }, [provider, selected?.status, selected?.selected_target_id]);
  useEffect(() => {
    setPostTitle(currentItem?.title || "");
    setPostDescription(currentItem?.description || "");
  }, [currentItem?.id, currentItem?.title, currentItem?.description]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => listener.remove();
  }, []);
  useEffect(() => {
    let cancelled = false;
    setReviewRecord(null);
    setReviewError("");
    setPrivacyExpanded(false);
    setTikTok(blankTikTok);
    setConsent(false);
    if (
      provider !== "tiktok" ||
      guest ||
      !focused ||
      !foreground ||
      selected?.status !== "authorized" ||
      !selected.selected_target_id
    ) {
      setReviewBusy(false);
      return;
    }
    setReviewBusy(true);
    const targetId = selected.selected_target_id;
    const loadReview = async () => {
      if (
        currentItem?.media_id &&
        (source === "original" || currentRender?.output_media_id)
      ) {
        const result = await api<TikTokReview>(
          "/api/publishing/tiktok/review",
          {
            item_id: currentItem.id,
            expected_media_id: currentItem.media_id,
            expected_target_id: targetId,
            ...(source === "rendered" ? { render_id: renderedId } : {}),
          },
        );
        const validated = validateTikTokReview(result, {
          itemId: currentItem.id,
          originalId: currentItem.media_id,
          targetId,
          renderId: source === "rendered" ? renderedId : null,
          mediaId:
            source === "rendered"
              ? currentRender!.output_media_id!
              : currentItem.media_id,
        });
        if (!cancelled)
          setReviewRecord({
            key: reviewScope,
            creator: validated.creator,
            source: validated,
          });
      } else {
        const options = await api<TikTokCreatorOptions>(
          "/api/publishing/connections/tiktok/creator-options",
          {},
        );
        if (!cancelled)
          setReviewRecord({ key: reviewScope, creator: options, source: null });
      }
    };
    void loadReview()
      .catch((e) => {
        if (!cancelled)
          setReviewError(
            e instanceof Error ? e.message : "TikTok review could not load.",
          );
      })
      .finally(() => {
        if (!cancelled) setReviewBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, guest, focused, foreground, reviewScope]);
  useEffect(() => {
    setBusy(false);
    if (!focused) setAuthUrl("");
  }, [focused]);
  useEffect(() => {
    let current = true;
    setRenders([]);
    if (!guest && itemId)
      void api<RenderJob[]>(
        `/api/render/jobs?item_id=${encodeURIComponent(itemId)}`,
      )
        .then((result) => {
          if (current) setRenders(result);
        })
        .catch((error: Error) => {
          if (current) setMessage(error.message);
        });
    return () => {
      current = false;
    };
  }, [api, guest, itemId, session?.user.id]);
  const load = useCallback(async () => {
    if (guest) return;
    const current = capture();
    const [config, result, exports] = await Promise.all([
      api<{ providers: Provider[] }>("/api/publishing/config"),
      api<{ connections: Connection[]; jobs: Receipt[] }>(
        "/api/publishing/connections",
      ),
      itemId
        ? api<RenderJob[]>(
            `/api/render/jobs?item_id=${encodeURIComponent(itemId)}`,
          )
        : Promise.resolve([]),
    ]);
    if (!current()) return;
    setProviders(config.providers);
    setConnections(result.connections);
    setJobs(result.jobs);
    setRenders(exports);
  }, [api, guest, itemId, capture]);
  useFocusEffect(
    useCallback(() => {
      const current = capture();
      void load().catch((e: Error) => {
        if (current()) setMessage(e.message);
      });
    }, [load, capture]),
  );
  async function run(work: (current: () => boolean) => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = capture();
    setBusy(true);
    setMessage("");
    try {
      await work(current);
    } catch (e) {
      if (current())
        setMessage(
          e instanceof Error ? e.message : "Publishing could not continue.",
        );
    } finally {
      inFlight.current = false;
      if (current()) setBusy(false);
    }
  }
  function resetApproval() {
    setConsent(false);
    setSubmitted(false);
    setRequestId(Crypto.randomUUID());
  }
  async function authorize() {
    const current = capture();
    const result = await api<{
      auth_url?: string;
      connect_via_portal?: string;
      detail?: string;
    }>(
      `/api/publishing/oauth/${provider}/start`,
      provider === "bluesky" ? { handle: blueskyHandle.trim() } : {},
    );
    if (!current()) return;
    const url = result.auth_url || result.connect_via_portal;
    if (url) {
      const parsed = new URL(url);
      if (
        parsed.username ||
        parsed.password ||
        !["https:", "http:"].includes(parsed.protocol) ||
        (parsed.protocol === "http:" &&
          !["localhost", "127.0.0.1"].includes(parsed.hostname))
      )
        throw new Error("Authorization requires a secure Ziipa web portal.");
      setAuthUrl(url);
    }
    setMessage(
      result.detail ||
        "Open authorization, approve your account, then return here and refresh.",
    );
  }
  async function publish() {
    if (!canPublish || submitted)
      throw new Error(
        "Review the current source, destination and required approvals before publishing.",
      );
    const current = capture();
    // Keep this identifier after a timeout. Refresh receipts instead of resending an uncertain upload.
    setSubmitted(true);
    const result = await api<Receipt>("/api/publishing/publish", {
      item_id: itemId,
      provider,
      expected_target_id: selected?.selected_target_id,
      expected_media_id: currentItem?.media_id,
      idempotency_key: requestId,
      privacy:
        provider === "facebook" ||
        provider === "instagram" ||
        provider === "bluesky"
          ? "public"
          : privacy,
      made_for_kids: madeForKids === true,
      consent,
      original_media_acknowledged: source === "original" && original,
      ...(source === "rendered" ? { render_id: renderedId } : {}),
      ...(provider === "tiktok"
        ? {
            tiktok: { ...tiktok, source_sha256: sourceReview?.source_sha256 },
            title: postTitle.trim(),
            description: postDescription,
          }
        : {}),
    });
    if (!current()) return;
    setMessage(result.detail);
    await load();
  }
  const canPublish =
    !guest &&
    !!currentItem &&
    !!selected?.can_publish &&
    !!ready?.configured &&
    !!ready?.publish_implemented &&
    consent &&
    (source === "rendered" ? !!currentRender : original) &&
    (provider !== "youtube" ||
      (madeForKids !== null &&
        (!ready?.allowed_privacy ||
          ready.allowed_privacy.includes(privacy)))) &&
    (provider !== "tiktok" ||
      (!reviewBusy &&
        tikTokReviewComplete(
          sourceReview,
          tiktok,
          postTitle,
          postDescription,
        )));
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.page}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.panel}>
        <ShieldCheck size={26} color={color.lime} />
        <Text style={styles.title}>Publish beyond Ziipa</Text>
        <Text style={styles.small}>
          Authorize the actual channel, choose your media and approve each
          destination. Linking a profile is separate from permission to publish.
        </Text>
      </View>
      {guest ? (
        <Notice text="Sign in to authorize accounts and publish your own uploaded media. Preview samples cannot be sent to a network." />
      ) : null}
      <Action
        title="Refresh accounts and delivery status"
        secondary
        icon={RefreshCw}
        busy={busy}
        onPress={() => void run(load)}
      />
      {message ? <Notice text={message} /> : null}
      <View style={{ gap: 10 }}>
        {providers.map((p) => (
          <Choice
            disabled={busy}
            key={p.provider}
            title={`${p.name} · ${p.configured ? "Ready to authorize" : p.publish_implemented || p.live_implemented ? "Provider setup needed" : "Manual sharing only"}`}
            active={provider === p.provider}
            onPress={() => {
              setProvider(p.provider);
              setReviewRecord(null);
              setTikTok(blankTikTok);
              setAuthUrl("");
              resetApproval();
            }}
          />
        ))}
      </View>
      {ready && (
        <View style={styles.panel}>
          <Text style={styles.heading}>{ready.name}</Text>
          <Text style={styles.small}>{ready.detail}</Text>
          {[...ready.requirements, ...(ready.delivery_requirements || [])].map(
            (r) => (
              <Text key={r} style={styles.small}>
                • {r}
              </Text>
            ),
          )}
          {provider === "bluesky" && (
            <Field
              label="Bluesky handle"
              placeholder="yourname.bsky.social"
              autoCapitalize="none"
              autoCorrect={false}
              value={blueskyHandle}
              onChangeText={setBlueskyHandle}
              editable={!busy}
            />
          )}
          <Action
            title={
              selected
                ? "Reauthorize account"
                : provider === "twitch"
                  ? "Authorize Twitch channel"
                  : "Authorize publishing account"
            }
            secondary
            disabled={
              !ready.configured ||
              guest ||
              (provider === "bluesky" && !blueskyHandle.trim())
            }
            busy={busy}
            onPress={() => void run(authorize)}
          />
          {authUrl ? (
            <Action
              title="Open secure authorization"
              onPress={() => {
                void Linking.openURL(authUrl).catch(() =>
                  setMessage(
                    "Could not open authorization. Use the Ziipa web portal.",
                  ),
                );
              }}
            />
          ) : null}
          {selected && (
            <>
              <Text style={styles.label}>Choose the channel you control</Text>
              {selected.targets.map((target) => (
                <Choice
                  disabled={busy}
                  key={target.id}
                  title={`${target.name} · ${target.kind}`}
                  active={selected.selected_target_id === target.id}
                  onPress={() => {
                    resetApproval();
                    void run(async (current) => {
                      await api(
                        `/api/publishing/connections/${provider}/target`,
                        { target_id: target.id },
                      );
                      if (current()) await load();
                    });
                  }}
                />
              ))}
              <Action
                title="Disconnect publishing permission"
                secondary
                busy={busy}
                onPress={() =>
                  void run(async (current) => {
                    await api(
                      `/api/publishing/connections/${provider}/disconnect`,
                      {},
                    );
                    if (!current()) return;
                    resetApproval();
                    await load();
                  })
                }
              />
            </>
          )}
        </View>
      )}
      {provider === "twitch" ? (
        <TwitchChannel
          key={`${selected?.selected_target_id || ""}:${selected?.status || ""}`}
          targetId={selected?.selected_target_id || ""}
          connected={selected?.status === "authorized"}
          onBroadcast={() => navigation.navigate("Live")}
        />
      ) : (
        <>
          <View style={styles.panel}>
            <Text style={styles.heading}>1. Your source media</Text>
            <Notice text="Choose a rendered MP4 to include saved editor effects. Ziipa checks that the export still matches your saved edit before sending it." />
            {ownMedia.map((item) => (
              <Choice
                disabled={busy}
                key={item.id}
                title={`${item.title} · ${item.visibility || "draft"}`}
                active={itemId === item.id}
                onPress={() => {
                  setItemId(item.id);
                  setOriginal(false);
                  setRenderedId("");
                  resetApproval();
                }}
              />
            ))}
            {!ownMedia.length && (
              <Action
                title="Create and upload media"
                secondary
                onPress={() => navigation.navigate("Composer")}
              />
            )}
            <Text style={styles.small}>
              Publish the creation in Ziipa first to make it available here.
              Private drafts are excluded.
            </Text>
            <Choice
              disabled={busy}
              title="Rendered edit — includes captions, overlays, trim and soundtrack"
              active={source === "rendered"}
              onPress={() => {
                setSource("rendered");
                resetApproval();
              }}
            />
            <Choice
              disabled={busy}
              title="Original file — excludes Ziipa editor effects"
              active={source === "original"}
              onPress={() => {
                setSource("original");
                resetApproval();
              }}
            />
            {source === "rendered" && (
              <>
                {renders
                  .filter((job) => readyRender(job, itemId))
                  .map((job) => (
                    <Choice
                      disabled={busy}
                      key={job.id}
                      title={`MP4 · ${new Date(job.created_at).toLocaleString()}`}
                      active={renderedId === job.id}
                      onPress={() => {
                        setRenderedId(job.id);
                        resetApproval();
                      }}
                    />
                  ))}
                {currentItem && (
                  <Action
                    title="Render or review saved exports"
                    secondary
                    onPress={() => navigation.navigate("Exports", { itemId })}
                  />
                )}
                {!currentRender && (
                  <Text style={styles.small}>
                    Select a ready export. Stale exports cannot be published.
                  </Text>
                )}
              </>
            )}
            {source === "original" && (
              <Consent
                disabled={busy}
                title="I approve sharing this original file. I understand that Ziipa editor effects are not rendered into it."
                value={original}
                onChange={(v) => {
                  setOriginal(v);
                  resetApproval();
                }}
              />
            )}
          </View>
          {provider === "youtube" && (
            <View style={styles.panel}>
              <Text style={styles.heading}>2. YouTube audience</Text>
              {(["private", "unlisted", "public"] as const)
                .filter(
                  (v) =>
                    !ready?.allowed_privacy ||
                    ready.allowed_privacy.includes(v),
                )
                .map((v) => (
                  <Choice
                    disabled={busy}
                    key={v}
                    title={v}
                    active={privacy === v}
                    onPress={() => {
                      setPrivacy(v);
                      resetApproval();
                    }}
                  />
                ))}
              <Text style={styles.label}>Is this video made for kids?</Text>
              <Choice
                disabled={busy}
                title="Yes, made for kids"
                active={madeForKids === true}
                onPress={() => {
                  setMadeForKids(true);
                  resetApproval();
                }}
              />
              <Choice
                disabled={busy}
                title="No, not made for kids"
                active={madeForKids === false}
                onPress={() => {
                  setMadeForKids(false);
                  resetApproval();
                }}
              />
            </View>
          )}
          {provider === "tiktok" && (
            <View style={styles.panel}>
              <Text style={styles.heading}>2. Review your TikTok post</Text>
              <Text style={styles.small}>
                Current creator permissions and the actual video are checked
                when you open this review or change the source. Nothing is sent
                to TikTok until you approve Publish.
              </Text>
              <Action
                title="Refresh TikTok account and video review"
                secondary
                busy={reviewBusy}
                disabled={
                  busy ||
                  selected?.status !== "authorized" ||
                  !selected.selected_target_id
                }
                onPress={() => setReviewVersion((value) => value + 1)}
              />
              {reviewBusy && (
                <Text accessibilityLiveRegion="polite" style={styles.small}>
                  Checking your TikTok account and selected video…
                </Text>
              )}
              {reviewError && <Notice error text={reviewError} />}
              {!sourceReview && !reviewBusy && (
                <Notice text="Select an original video or a ready export above to review the exact outgoing file. Publishing stays disabled until server verification succeeds." />
              )}
              {creator && (
                <>
                  <Text style={styles.label}>
                    Posting as {creator.creator_nickname}
                  </Text>
                  {previewItem && (
                    <View style={{ overflow: "hidden", borderRadius: 18 }}>
                      <Text style={styles.label}>
                        {source === "rendered"
                          ? "Exact rendered MP4"
                          : "Exact original video — no Ziipa effects"}
                      </Text>
                      <MediaPlayer
                        key={
                          sourceReview!.source_sha256 +
                          ":" +
                          sourceReview!.media_id
                        }
                        item={previewItem}
                      />
                    </View>
                  )}
                  {sourceReview && (
                    <Text
                      style={
                        sourceReview.duration_seconds >
                        creator.max_video_post_duration_sec
                          ? styles.error
                          : styles.small
                      }
                    >
                      Verified video: {sourceReview.duration_seconds.toFixed(2)}{" "}
                      seconds · account maximum{" "}
                      {creator.max_video_post_duration_sec} seconds
                    </Text>
                  )}
                  <Field
                    label="TikTok title"
                    value={postTitle}
                    onChangeText={setPostTitle}
                    editable={!busy}
                    maxLength={100}
                  />
                  <Field
                    label="TikTok description and hashtags"
                    value={postDescription}
                    onChangeText={setPostDescription}
                    editable={!busy}
                    multiline
                    maxLength={2200}
                  />
                  <Text
                    style={
                      (
                        postTitle.trim() +
                        (postDescription ? "\n" + postDescription : "")
                      ).length > 2200
                        ? styles.error
                        : styles.small
                    }
                  >
                    {
                      (
                        postTitle.trim() +
                        (postDescription ? "\n" + postDescription : "")
                      ).length
                    }{" "}
                    / 2,200 caption characters. This changes only the TikTok
                    post text.
                  </Text>
                  <Text style={styles.label}>Who can watch this post?</Text>
                  <Pressable
                    accessibilityRole="combobox"
                    accessibilityLabel="TikTok privacy"
                    accessibilityState={{
                      expanded: privacyExpanded,
                      disabled: busy || reviewBusy,
                    }}
                    disabled={busy || reviewBusy}
                    onPress={() => setPrivacyExpanded((value) => !value)}
                    style={[
                      styles.input,
                      {
                        flexDirection: "row",
                        justifyContent: "space-between",
                        alignItems: "center",
                      },
                    ]}
                  >
                    <Text style={styles.body}>
                      {privacyLabels[tiktok.privacy_level] ||
                        "Choose visibility"}
                    </Text>
                    <Text style={styles.body}>
                      {privacyExpanded ? "⌃" : "⌄"}
                    </Text>
                  </Pressable>
                  {privacyExpanded && (
                    <View style={{ gap: 8 }}>
                      {creator.privacy_level_options.map((value) => (
                        <Choice
                          key={value}
                          title={
                            (privacyLabels[value] || value) +
                            (tiktok.brand_content_toggle &&
                            value === "SELF_ONLY"
                              ? " · unavailable for branded content"
                              : "")
                          }
                          active={tiktok.privacy_level === value}
                          disabled={
                            busy ||
                            (tiktok.brand_content_toggle &&
                              value === "SELF_ONLY")
                          }
                          onPress={() => {
                            setTikTok({ ...tiktok, privacy_level: value });
                            setPrivacyExpanded(false);
                            resetApproval();
                          }}
                        />
                      ))}
                    </View>
                  )}
                  {!creator.privacy_level_options.length && (
                    <Notice
                      error
                      text="TikTok is not currently allowing a post from this account. Try again later."
                    />
                  )}
                  <Text style={styles.label}>Allow interactions</Text>
                  {(
                    [
                      [
                        "disable_comment",
                        "Allow comments",
                        creator.comment_disabled,
                      ],
                      ["disable_duet", "Allow Duet", creator.duet_disabled],
                      [
                        "disable_stitch",
                        "Allow Stitch",
                        creator.stitch_disabled,
                      ],
                    ] as const
                  ).map(([key, title, locked]) => (
                    <Consent
                      key={key}
                      disabled={busy || locked}
                      title={
                        title +
                        (locked ? " · disabled in TikTok account settings" : "")
                      }
                      value={!locked && !tiktok[key]}
                      onChange={(value) => {
                        setTikTok({ ...tiktok, [key]: !value });
                        resetApproval();
                      }}
                    />
                  ))}
                  <Consent
                    title="Disclose commercial content"
                    disabled={busy}
                    value={tiktok.content_disclosure_enabled}
                    onChange={(value) => {
                      setTikTok({
                        ...tiktok,
                        content_disclosure_enabled: value,
                        brand_content_toggle: false,
                        brand_organic_toggle: false,
                        branded_content_policy_confirmed: false,
                        music_usage_confirmed: false,
                      });
                      resetApproval();
                    }}
                  />
                  <Text style={styles.small}>
                    Enable this if the content promotes you, a brand, product or
                    service.
                  </Text>
                  {tiktok.content_disclosure_enabled && (
                    <>
                      <Checkbox
                        title="Your brand — promoting yourself or your business"
                        value={tiktok.brand_organic_toggle}
                        disabled={busy}
                        onChange={(value) => {
                          setTikTok({
                            ...tiktok,
                            brand_organic_toggle: value,
                            music_usage_confirmed: false,
                          });
                          resetApproval();
                        }}
                      />
                      <Checkbox
                        title="Branded content — promoting a third party"
                        value={tiktok.brand_content_toggle}
                        disabled={busy}
                        onChange={(value) => {
                          setTikTok({
                            ...tiktok,
                            brand_content_toggle: value,
                            privacy_level:
                              value && tiktok.privacy_level === "SELF_ONLY"
                                ? ""
                                : tiktok.privacy_level,
                            music_usage_confirmed: false,
                            branded_content_policy_confirmed: false,
                          });
                          resetApproval();
                        }}
                      />
                      {!tiktok.brand_content_toggle &&
                        !tiktok.brand_organic_toggle && (
                          <Notice
                            error
                            text="Indicate whether this content promotes yourself, a third party, or both before publishing."
                          />
                        )}
                      {(tiktok.brand_content_toggle ||
                        tiktok.brand_organic_toggle) && (
                        <Text style={styles.small}>
                          {tiktok.brand_content_toggle
                            ? "Your video will be labeled Paid partnership. Branded content cannot use Only me visibility."
                            : "Your video will be labeled Promotional content."}
                        </Text>
                      )}
                    </>
                  )}
                  <Consent
                    title="This content is AI generated"
                    value={tiktok.is_aigc}
                    disabled={busy}
                    onChange={(value) => {
                      setTikTok({ ...tiktok, is_aigc: value });
                      resetApproval();
                    }}
                  />
                  <Checkbox
                    disabled={busy}
                    title="By posting, I agree to TikTok's Music Usage Confirmation."
                    value={tiktok.music_usage_confirmed}
                    onChange={(value) => {
                      setTikTok({ ...tiktok, music_usage_confirmed: value });
                      resetApproval();
                    }}
                  />
                  <Action
                    title="Read TikTok Music Usage Confirmation"
                    secondary
                    onPress={() =>
                      void Linking.openURL(
                        "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en",
                      ).catch(() =>
                        setMessage(
                          "Could not open TikTok policy. Please check your connection.",
                        ),
                      )
                    }
                  />
                  {tiktok.brand_content_toggle && (
                    <>
                      <Checkbox
                        disabled={busy}
                        title="By posting, I also agree to TikTok's Branded Content Policy."
                        value={tiktok.branded_content_policy_confirmed}
                        onChange={(value) => {
                          setTikTok({
                            ...tiktok,
                            branded_content_policy_confirmed: value,
                          });
                          resetApproval();
                        }}
                      />
                      <Action
                        title="Read TikTok Branded Content Policy"
                        secondary
                        onPress={() =>
                          void Linking.openURL(
                            "https://www.tiktok.com/legal/page/global/bc-policy/en",
                          ).catch(() =>
                            setMessage(
                              "Could not open TikTok policy. Please check your connection.",
                            ),
                          )
                        }
                      />
                    </>
                  )}
                  <Text style={styles.small}>
                    TikTok may take several minutes to process your post. Check
                    delivery receipts for the confirmed result. Ziipa does not
                    automatically add promotional logos or watermarks.
                  </Text>
                </>
              )}
            </View>
          )}
          {(provider === "facebook" || provider === "instagram") && (
            <Notice text="This publishes publicly to the Page or professional Instagram account you selected above. It does not publish to personal Facebook profiles." />
          )}
          {provider === "bluesky" && (
            <Notice text="Bluesky posts are public and may be indexed or copied by other AT Protocol apps. Deleting a Ziipa account does not delete copies on external networks." />
          )}
          <View style={styles.panel}>
            <Text style={styles.heading}>3. Approve this destination</Text>
            <Consent
              disabled={busy}
              title={`I control the selected ${ready?.name || provider} account and authorize sending this media with the audience and disclosures above. I have the rights to publish it.`}
              value={consent}
              onChange={setConsent}
            />
            <Action
              title={`Publish to ${ready?.name || provider}`}
              icon={Send}
              busy={busy}
              disabled={!canPublish || submitted}
              onPress={() => void run(publish)}
            />
            {submitted && (
              <Notice text="Request submitted. Refresh receipts below before trying again. A timeout can mean the provider received the upload; Ziipa will not automatically send a duplicate." />
            )}
          </View>
        </>
      )}
      <Text style={styles.heading}>Delivery receipts</Text>
      {!jobs.length && (
        <Text style={styles.small}>
          No automatic posts have been submitted.
        </Text>
      )}
      {jobs.map((job) => (
        <View key={job.id} style={styles.panel}>
          <View style={styles.row}>
            <CheckCircle2
              size={19}
              color={job.status === "delivered" ? color.lime : color.muted}
            />
            <Text style={styles.label}>
              {job.provider} · {job.status}
            </Text>
          </View>
          <Text style={styles.small}>{job.detail}</Text>
          <Text selectable style={styles.small}>
            {job.id}
          </Text>
          <Action
            title="Check this receipt"
            secondary
            busy={busy}
            onPress={() =>
              void run(async (current) => {
                const result = await api<Receipt>(
                  `/api/publishing/jobs/${job.id}/refresh`,
                  {},
                );
                if (!current()) return;
                setMessage(result.detail);
                await load();
              })
            }
          />
        </View>
      ))}
      <Action
        title="Manual sharing and network feeds"
        secondary
        onPress={() => navigation.navigate("Connections", { tab: "outbox" })}
      />
    </ScrollView>
  );
}
