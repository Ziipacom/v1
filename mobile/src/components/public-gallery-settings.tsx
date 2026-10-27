import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import {
  Linking,
  Platform,
  Pressable,
  Share,
  Switch,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import {
  Copy,
  ExternalLink,
  Link2,
  RefreshCw,
  Share2,
} from "lucide-react-native";
import { Action, Field, IconButton, Notice } from "./ui";
import { useDesktopLayout } from "./desktop-layout";
import { workspace } from "./desktop-workspace";
import { useZiipa } from "../provider";
import { useOperationScope } from "../lib/use-operation-scope";
import {
  emptyPublicGalleryForm,
  loopbackGalleryBrowser,
  mergePublicGalleryRefresh,
  publicGalleryDirty,
  publicGalleryFailure,
  publicGalleryRequest,
  publicGalleryRoot,
  readPublicGallerySettings,
  trustedPublicGalleryUrl,
  type PublicGalleryForm,
} from "../lib/public-gallery";
import { color, font, styles } from "../theme";

type Props = {
  disabled?: boolean;
  refreshKey?: number;
  onOpenCreations?: () => void;
};

export function PublicGallerySettingsPanel(props: Props) {
  const { session } = useZiipa();
  return (
    <ScopedPublicGallerySettings
      key={session?.access_token || "guest"}
      {...props}
    />
  );
}

function ScopedPublicGallerySettings({
  disabled = false,
  refreshKey = 0,
  onOpenCreations,
}: Props) {
  const { api, session } = useZiipa();
  const { desktop } = useDesktopLayout();
  const focused = useIsFocused();
  const capture = useOperationScope(session?.access_token || "guest", focused);
  const ownerCapture = useOperationScope(session?.access_token || "guest");
  const [form, setForm] = useState(emptyPublicGalleryForm);
  const formRef = useRef(form);
  formRef.current = form;
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [deploymentRequired, setDeploymentRequired] = useState(false);
  const readEpoch = useRef(0);
  const writeLock = useRef(false);
  const linkLock = useRef(false);
  const allowLoopback =
    Platform.OS === "web" &&
    typeof globalThis.location !== "undefined" &&
    loopbackGalleryBrowser(globalThis.location.hostname);
  const updateForm = useCallback(
    (change: (current: PublicGalleryForm) => PublicGalleryForm) => {
      const next = change(formRef.current);
      formRef.current = next;
      setForm(next);
      return next;
    },
    [],
  );
  const load = useCallback(
    async (manual = false) => {
      if (!session || !focused) return;
      const valid = capture(),
        run = ++readEpoch.current;
      if (!valid()) return;
      setLoading(true);
      setError("");
      try {
        const saved = readPublicGallerySettings(
          await api<unknown>(publicGalleryRoot),
          allowLoopback,
        );
        if (!valid() || readEpoch.current !== run) return;
        const next = updateForm((current) =>
          mergePublicGalleryRefresh(current, saved, manual),
        );
        setDeploymentRequired(false);
        if (next.needsReview)
          setMessage(
            "Gallery settings changed elsewhere. Your edits are kept. Refresh to review the latest revision before saving.",
          );
        else if (manual)
          setMessage(
            publicGalleryDirty(next)
              ? "Latest saved status loaded. Your unsaved changes are kept; review them before saving."
              : "Gallery settings are up to date.",
          );
      } catch (cause) {
        if (!valid() || readEpoch.current !== run) return;
        const failure = publicGalleryFailure(cause);
        if (failure.kind === "deployment") setDeploymentRequired(true);
        setError(failure.message);
      } finally {
        if (valid() && readEpoch.current === run) setLoading(false);
      }
    },
    [api, session?.access_token, focused, capture, allowLoopback, updateForm],
  );
  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        readEpoch.current++;
      };
    }, [load, refreshKey]),
  );
  useEffect(() => {
    if (focused) return;
    setLoading(false);
    if (writeLock.current)
      updateForm((current) => ({ ...current, needsReview: true }));
  }, [focused, updateForm]);

  async function save() {
    if (
      !session ||
      !focused ||
      disabled ||
      loading ||
      saving ||
      deploymentRequired ||
      writeLock.current ||
      !publicGalleryDirty(formRef.current)
    )
      return;
    let input: ReturnType<typeof publicGalleryRequest>;
    try {
      input = publicGalleryRequest(formRef.current);
    } catch (cause) {
      setError((cause as Error).message);
      return;
    }
    const valid = capture(),
      ownerValid = ownerCapture(),
      run = ++readEpoch.current;
    if (!valid()) return;
    writeLock.current = true;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const saved = readPublicGallerySettings(
        await api<unknown>(input.path, input.body),
        allowLoopback,
      );
      if (!valid() || readEpoch.current !== run) return;
      if (
        saved.slug !== input.slug ||
        saved.enabled !== input.enabled ||
        saved.revision < input.revision
      )
        throw new Error("The returned settings did not confirm this change.");
      const next = updateForm((current) => ({
        saved,
        slug:
          input.revoking && current.slug.trim()
            ? current.slug
            : saved.slug || "",
        enabled: saved.enabled,
        needsReview: false,
      }));
      setDeploymentRequired(false);
      setMessage(
        saved.enabled
          ? "Your public gallery settings are saved. Only the server-confirmed link below can be shared."
          : publicGalleryDirty(next)
            ? "Public gallery is off. Your unsaved address change is kept for a separate save."
            : "Public gallery is off. Your current and previous addresses stay reserved to your account until account deletion.",
      );
    } catch (cause) {
      if (!valid() || readEpoch.current !== run) return;
      const failure = publicGalleryFailure(cause, true);
      setError(failure.message);
      if (failure.kind === "deployment") setDeploymentRequired(true);
      if (
        failure.kind === "conflict" ||
        failure.kind === "unconfirmed" ||
        failure.kind === "privacy"
      )
        updateForm((current) => ({ ...current, needsReview: true }));
    } finally {
      writeLock.current = false;
      if (ownerValid()) setSaving(false);
    }
  }
  const busy = disabled || loading || saving || linkBusy;
  let currentUrl: string | null = null;
  if (!deploymentRequired && form.saved?.enabled && form.saved.profile_public)
    currentUrl = trustedPublicGalleryUrl(
      form.saved.public_url,
      form.saved.slug,
      allowLoopback,
    );

  async function linkAction(kind: "copy" | "open" | "share") {
    if (!currentUrl || !focused || busy || linkLock.current) return;
    const valid = capture();
    const ownerValid = ownerCapture();
    if (!valid()) return;
    const url = trustedPublicGalleryUrl(
      currentUrl,
      form.saved?.slug || null,
      allowLoopback,
    );
    if (!url) return;
    linkLock.current = true;
    setLinkBusy(true);
    setError("");
    setMessage("");
    try {
      if (kind === "open") {
        await Linking.openURL(url);
        if (valid())
          setMessage(
            "Public gallery opened. Its visitors can view published creations without signing in.",
          );
      } else if (kind === "copy") {
        if (!(await Clipboard.setStringAsync(url)))
          throw new Error("Clipboard unavailable");
        if (valid()) setMessage("Public gallery link copied.");
      } else {
        if (Platform.OS === "web") {
          if (typeof navigator.share === "function")
            await navigator.share({ title: "My Ziipa gallery", url });
          else {
            if (!(await Clipboard.setStringAsync(url)))
              throw new Error("Clipboard unavailable");
            if (valid())
              setMessage(
                "Sharing is unavailable in this browser. Your public gallery link was copied instead.",
              );
            return;
          }
        } else {
          const result = await Share.share({
            title: "My Ziipa gallery",
            message: url,
          });
          if (result.action === Share.dismissedAction) return;
        }
        if (valid())
          setMessage(
            "Share action completed. Ziipa does not automatically post your link to any network.",
          );
      }
    } catch (cause) {
      if (valid() && (cause as { name?: string }).name !== "AbortError")
        setError(
          "This link action was unavailable. You can select and copy the confirmed URL below.",
        );
    } finally {
      linkLock.current = false;
      if (ownerValid()) setLinkBusy(false);
    }
  }
  return (
    <View style={[styles.panel, desktop && workspace.panel, { gap: 10 }]}>
      <View style={styles.between}>
        <View style={styles.row}>
          <Link2 size={19} color={color.lime} />
          <Text accessibilityRole="header" style={styles.heading}>
            Public gallery link
          </Text>
        </View>
        <IconButton
          icon={RefreshCw}
          label="Refresh gallery status"
          disabled={busy || !session}
          onPress={() => void load(true)}
        />
      </View>
      <Text style={styles.small}>
        Opt in to a shareable page with your published creations and current
        avatar and cover. Anyone with the link can view it without signing in.
        Private drafts are never included.
      </Text>
      <Text style={[styles.small, { fontSize: 11 }]}>
        Plain published media can appear now. Creations with cuts, captions,
        overlays, effects or added audio stay excluded in this version. Publish
        the finished video as a separate creation to include it. This setting
        does not queue an export.
      </Text>
      {!!form.saved?.pending_render_count && (
        <Notice
          text={`${form.saved.pending_render_count} published creation${form.saved.pending_render_count === 1 ? " has edits and is" : "s have edits and are"} excluded here. Publish the finished media as a separate creation to include it. This count is not a render queue.`}
        />
      )}
      {!session ? (
        <Notice text="Sign in to set up a public gallery. No address has been reserved." />
      ) : (
        <>
          <Field
            label="Custom gallery address"
            value={form.slug}
            onChangeText={(slug) => {
              if (busy || !focused) return;
              updateForm((current) => ({ ...current, slug }));
              setMessage("");
            }}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={40}
            editable={!busy && !!form.saved && !deploymentRequired}
            placeholder="your-creator-name"
          />
          <Text style={[styles.small, { fontSize: 11 }]}>
            Your address uses ziipa.com/g/ followed by this name. Availability
            is checked only when you save. Changing it stops the previous link;
            old names stay reserved to your account until account deletion.
          </Text>
          <View style={styles.between}>
            <Text style={[styles.body, { flex: 1 }]}>
              Enable public gallery
            </Text>
            <Switch
              accessibilityLabel="Enable public gallery"
              value={form.enabled}
              onValueChange={(enabled) => {
                if (
                  busy ||
                  !focused ||
                  !form.saved ||
                  (!form.saved.profile_public && enabled)
                )
                  return;
                updateForm((current) => ({ ...current, enabled }));
                setMessage("");
              }}
              disabled={
                busy ||
                !form.saved ||
                deploymentRequired ||
                (!form.enabled && !form.saved.profile_public)
              }
              trackColor={{ true: color.purple }}
            />
          </View>
          {form.saved && !form.saved.profile_public && (
            <Text style={styles.small}>
              You can reserve an address while your profile is private. To
              enable the public page, deliberately save public profile
              visibility in Privacy controls first.
            </Text>
          )}
          {form.saved && (
            <Text style={styles.small}>
              Last saved status:{" "}
              {form.saved.enabled && form.saved.profile_public
                ? "public gallery enabled"
                : "public gallery unavailable"}
              {form.saved.slug
                ? ` · reserved address: ${form.saved.slug}`
                : " · no address reserved"}
              .
            </Text>
          )}
          <Action
            title="Save gallery settings"
            busy={saving}
            disabled={
              busy ||
              deploymentRequired ||
              !form.saved ||
              form.needsReview ||
              !publicGalleryDirty(form) ||
              (!form.slug.trim() && !(form.saved?.enabled && !form.enabled)) ||
              (form.enabled && !form.saved.profile_public)
            }
            onPress={() => void save()}
          />
          {currentUrl && (
            <View style={{ gap: 8 }}>
              <Text style={styles.label}>Current public URL</Text>
              <Text selectable style={styles.small}>
                {currentUrl}
              </Text>
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                {(
                  [
                    ["copy", "Copy", Copy],
                    ["open", "Open gallery", ExternalLink],
                    ["share", "Share", Share2],
                  ] as const
                ).map(([kind, label, Icon]) => (
                  <Pressable
                    key={kind}
                    accessibilityRole="button"
                    accessibilityLabel={`${label} public gallery link`}
                    disabled={busy}
                    onPress={() => void linkAction(kind)}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      borderColor: color.border,
                      borderWidth: 1,
                      borderRadius: 8,
                      padding: 10,
                      opacity: busy ? 0.5 : 1,
                    }}
                  >
                    <Icon size={16} color={color.text} />
                    <Text
                      style={{
                        color: color.text,
                        fontFamily: font.medium,
                        fontSize: 12,
                      }}
                    >
                      {label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
          {onOpenCreations && (
            <Action
              secondary
              title="Manage my creations"
              disabled={busy}
              onPress={onOpenCreations}
            />
          )}
        </>
      )}
      {loading && (
        <Text accessibilityLiveRegion="polite" style={styles.small}>
          Loading saved gallery settings…
        </Text>
      )}
      {!!error && <Notice error text={error} />}
      {!!message && <Notice text={message} />}
    </View>
  );
}
