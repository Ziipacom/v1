import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import {
  CalendarClock,
  Check,
  Clapperboard,
  ExternalLink,
  FolderOpen,
  Link2,
  Megaphone,
  Minus,
  Plus,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react-native";
import { Action, Cover, Field, Notice, Pill } from "./ui";
import { useDesktopLayout } from "./desktop-layout";
import { workspace } from "./desktop-workspace";
import { useZiipa } from "../provider";
import { useOperationScope } from "../lib/use-operation-scope";
import {
  campaignLabel,
  campaignRoot,
  type Campaign,
  type CampaignConfig,
  type CampaignConnection,
  type CampaignProvider,
} from "../lib/campaign-types";
import {
  marketingTools,
  organicPromotionStatus,
  organicProviderNames,
  promotionProject,
  promotionSources,
  type PromotionBrief,
} from "../lib/promotion";
import { socialProviders } from "../lib/social";
import type { Project } from "../lib/media-os-types";
import type { Item, RootStack } from "../lib/types";
import { color, font, styles } from "../theme";

type Props = {
  navigation: NativeStackNavigationProp<RootStack>;
  initialItem?: Item;
};
type Snapshot = {
  campaigns: Campaign[];
  config: CampaignConfig;
  providers: CampaignProvider[];
  connections: CampaignConnection[];
  projects: Project[];
};

function Block({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  const { desktop } = useDesktopLayout();
  return (
    <View style={[styles.panel, { gap: 12 }, desktop && { padding: 20, borderRadius: 12 }]}>
      <Text accessibilityRole="header" style={[styles.heading, { fontSize: desktop ? 19 : 21 }]}>
        {title}
      </Text>
      {!!detail && <Text style={styles.small}>{detail}</Text>}
      {children}
    </View>
  );
}

export function PromotionHub(props: Props) {
  const { session } = useZiipa();
  return <ScopedPromotionHub key={session?.access_token || "guest"} {...props} />;
}

function ScopedPromotionHub({ navigation, initialItem }: Props) {
  const { desktop } = useDesktopLayout();
  const { api, data, session, guest } = useZiipa();
  const focused = useIsFocused();
  const capture = useOperationScope(session?.access_token || "guest", focused);
  const signedIn = !!session && !guest;
  const sources = promotionSources(data.drafts, signedIn ? session.user.id : undefined);
  const [sourceId, setSourceId] = useState(initialItem?.id || "");
  const source = sources.find((item) => item.id === sourceId);
  const [query, setQuery] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [savedProject, setSavedProject] = useState<Project | null>(null);
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [openNetwork, setOpenNetwork] = useState<string | null>(null);
  const [openTool, setOpenTool] = useState<string | null>(null);
  const [brief, setBrief] = useState<PromotionBrief>({
    name: initialItem?.title.slice(0, 120) || "",
    objective: "Release a creation",
    audience: "",
    message: "",
    tools: [],
  });
  const updateBrief = (patch: Partial<PromotionBrief>) => {
    setBrief((value) => ({ ...value, ...patch }));
    setSavedProject(null);
    setNotice("");
  };
  const load = useCallback(async () => {
    if (!signedIn || !focused) return;
    const valid = capture();
    setLoading(true);
    setError("");
    setSnapshot(null);
    try {
      const [campaigns, config, providers, connections, projects] = await Promise.all([
        api<Campaign[]>(campaignRoot),
        api<CampaignConfig>(`${campaignRoot}/config`),
        api<{ providers: CampaignProvider[] }>("/api/publishing/config"),
        api<{ connections: CampaignConnection[] }>("/api/publishing/connections"),
        api<Project[]>("/api/os/projects"),
      ]);
      if (valid())
        setSnapshot({
          campaigns,
          config,
          providers: providers.providers,
          connections: connections.connections,
          projects,
        });
    } catch (cause) {
      if (valid())
        setError(
          cause instanceof Error
            ? cause.message
            : "Promotion readiness could not load. Nothing was activated.",
        );
    } finally {
      if (valid()) setLoading(false);
    }
  }, [api, signedIn, focused, capture]);
  useEffect(() => {
    void load();
  }, [load]);

  async function saveBrief() {
    if (!signedIn || saving || saveLock.current || !focused || savedProject) return;
    const valid = capture();
    saveLock.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = promotionProject(brief, source);
      const project = await api<Project>("/api/os/projects", payload);
      if (!valid()) return;
      setSavedProject(project);
      setSnapshot((value) =>
        value ? { ...value, projects: [project, ...value.projects] } : value,
      );
      setNotice(
        "Promotion brief saved as a private Media OS project. It does not publish, send email, schedule delivery or authorize advertising.",
      );
    } catch (cause) {
      if (valid())
        setError(
          cause instanceof Error ? cause.message : "Your promotion brief could not be saved.",
        );
    } finally {
      saveLock.current = false;
      // This instance is keyed to its account. A completed save must not leave
      // its controls busy after a blur/refocus, even when result display expired.
      setSaving(false);
    }
  }

  const stats = [
    ["Owned video sources", signedIn ? String(sources.length) : "—"],
    ["Release campaigns", snapshot ? String(snapshot.campaigns.length) : "—"],
    [
      "Scheduled releases",
      snapshot
        ? String(snapshot.campaigns.filter((item) => item.status === "scheduled").length)
        : "—",
    ],
    [
      "Planning briefs",
      snapshot
        ? String(snapshot.projects.filter((item) => item.name.startsWith("Promotion · ")).length)
        : "—",
    ],
  ];
  const workflow = (
    <Block
      title="Plan → prepare → review → distribute"
      detail="Organic releases use Ziipa's existing creation-to-distribution workflow. Each provider and release still needs its own authorization and review."
    >
      <View style={{ gap: 8 }}>
        {[
          "1. Choose owned media and confirm music/source rights.",
          "2. Prepare the actual portrait, square or landscape versions in Campaigns.",
          "3. Review exported media, destination privacy and provider-specific permissions.",
          "4. Approve the release and schedule delivery inside Campaigns; Calendar can organize reminders.",
          "5. Check delivery receipts, failures and Media OS insights. A schedule is not proof of posting.",
        ].map((line) => (
          <Text key={line} style={styles.small}>
            {line}
          </Text>
        ))}
      </View>
      {snapshot && (
        <Notice
          text={
            snapshot.config.detail ||
            (snapshot.config.can_run
              ? "Campaign processing is available. Review and approve each release before scheduled distribution."
              : "Background campaign processing is not currently ready. Open Campaigns to review its exact requirements; no automation is claimed active.")
          }
        />
      )}
    </Block>
  );

  const sourcePicker = (
    <Block
      title="Choose a creation"
      detail="Release campaigns currently support owned saved video sources. Still images and standalone audio can use the editor and provider-specific publishing review where supported."
    >
      <Field
        label="Search owned videos"
        value={query}
        maxLength={140}
        onChangeText={setQuery}
        placeholder="Creation title or tag"
        editable={!saving}
      />
      {!sources.length ? (
        <Notice
          text={
            signedIn
              ? "No eligible saved video sources yet. Create or upload a video, save it privately, then return to prepare a reviewed campaign."
              : "Sign in to use your saved media. Sample content cannot be promoted or posted."
          }
        />
      ) : (
        sources
          .filter((item) =>
            `${item.title} ${item.tags.join(" ")}`
              .toLowerCase()
              .includes(query.trim().toLowerCase()),
          )
          .slice(0, 8)
          .map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="radio"
              accessibilityLabel={`Select ${item.title}`}
              accessibilityState={{
                checked: source?.id === item.id,
                disabled: saving,
              }}
              aria-checked={source?.id === item.id}
              disabled={saving}
              onPress={() => {
                setSourceId(item.id);
                if (!brief.name) updateBrief({ name: item.title.slice(0, 120) });
                else {
                  setSavedProject(null);
                  setNotice("");
                }
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                padding: 10,
                borderWidth: 1,
                borderColor: source?.id === item.id ? color.lime : color.border,
                borderRadius: 10,
              }}
            >
              <Cover item={item} style={{ width: 68, height: 44, borderRadius: 7 }} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={2} style={styles.label}>
                  {item.title}
                </Text>
                <Text style={styles.small}>
                  {item.visibility === "published" ? "Published source" : "Private draft"} · video
                </Text>
              </View>
              {source?.id === item.id && <Check size={18} color={color.lime} />}
            </Pressable>
          ))
      )}
      {sources.length > 8 && (
        <Text style={styles.small}>
          Search to narrow the first eight matches. The full library remains available in the
          creator workspace.
        </Text>
      )}
      <Action
        title="Create or upload media"
        icon={Sparkles}
        secondary
        disabled={saving}
        onPress={() => navigation.navigate("Composer")}
      />
    </Block>
  );

  const briefEditor = (
    <Block
      title="Promotion brief"
      detail="Save goals, audience notes and integration checklists in your private Media OS workspace. This is planning data, not an instruction to spend or send."
    >
      <Field
        label="Brief name"
        value={brief.name}
        maxLength={120}
        onChangeText={(name) => updateBrief({ name })}
        editable={!saving}
        placeholder="New release or creator launch"
      />
      <Text style={styles.label}>Objective</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {["Awareness", "Grow an audience", "Release a creation", "Marketplace interest"].map(
          (objective) => (
            <Pill
              key={objective}
              title={objective}
              active={brief.objective === objective}
              onPress={() => {
                if (!saving) updateBrief({ objective });
              }}
            />
          ),
        )}
      </View>
      <Field
        label="Audience and context"
        value={brief.audience}
        maxLength={400}
        multiline
        onChangeText={(audience) => updateBrief({ audience })}
        editable={!saving}
        placeholder="Who is this for? Do not paste email lists or personal audience data."
      />
      <Field
        label="Message or call to action"
        value={brief.message}
        maxLength={1000}
        multiline
        onChangeText={(message) => updateBrief({ message })}
        editable={!saving}
        placeholder="What should viewers do after watching?"
      />
      <Text style={styles.small}>
        {source
          ? `Linked source: ${source.title}`
          : "No source linked. You can choose a creation later in Media OS."}
      </Text>
      <Action
        title={savedProject ? "Private brief saved" : "Save private promotion brief"}
        icon={Save}
        busy={saving}
        disabled={!signedIn || !brief.name.trim() || !!savedProject}
        onPress={() => void saveBrief()}
      />
      <Action
        title="Open projects & goals in Media OS"
        icon={FolderOpen}
        secondary
        disabled={saving}
        onPress={() => navigation.navigate("MediaOS", { tab: "Overview" })}
      />
      <Action
        title="Review workflow automation"
        icon={CalendarClock}
        secondary
        disabled={saving}
        onPress={() => navigation.navigate("MediaOS", { tab: "Workflows" })}
      />
    </Block>
  );

  const organicPanel = (
    <Block
      title="Organic network publishing"
      detail="These are current publishing permissions, not email or paid-ad permissions. Even an authorized connection needs final content/destination review."
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {socialProviders.map((entry) => {
          const provider = snapshot?.providers.find((value) => value.provider === entry.id);
          const connection = snapshot?.connections.find((value) => value.provider === entry.id);
          const readiness = organicPromotionStatus(provider, connection);
          const requirements = [
            ...(provider?.requirements || []),
            ...(provider?.delivery_requirements || []),
          ];
          return (
            <View
              key={entry.id}
              style={{
                flexBasis: desktop ? 280 : "100%",
                flexGrow: 1,
                minWidth: 0,
                borderWidth: 1,
                borderColor: color.border,
                borderRadius: 10,
                padding: 16,
                gap: 10,
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${openNetwork === entry.id ? "Collapse" : "Expand"} ${organicProviderNames[entry.id]} details`}
                accessibilityState={{ expanded: openNetwork === entry.id }}
                onPress={() => setOpenNetwork(openNetwork === entry.id ? null : entry.id)}
                style={[styles.between, { minHeight: 32 }]}
              >
                <Text style={styles.label}>{organicProviderNames[entry.id]}</Text>
                <View style={styles.row}>
                  {readiness.ready && <ShieldCheck size={18} color={color.lime} />}
                  {openNetwork === entry.id ? (
                    <Minus size={18} color={color.lime} />
                  ) : (
                    <Plus size={18} color={color.muted} />
                  )}
                </View>
              </Pressable>
              <Text style={[styles.small, { color: readiness.ready ? color.lime : color.muted }]}>
                {loading ? "Checking readiness…" : readiness.label}
              </Text>
              {openNetwork === entry.id && (
                <>
                  <Text style={styles.small}>
                    {connection?.selected_target_id
                      ? connection.targets.find(
                          (target) => target.id === connection.selected_target_id,
                        )?.name || "Selected destination"
                      : entry.formats}
                  </Text>
                  {!!requirements.length && (
                    <Text style={[styles.small, { fontSize: 12 }]}>
                      {requirements.slice(0, 3).join(" · ")}
                    </Text>
                  )}
                  <Action
                    title={`Manage ${organicProviderNames[entry.id]}`}
                    icon={Link2}
                    secondary
                    disabled={saving}
                    onPress={() => navigation.navigate("Connections", { tab: "accounts" })}
                  />
                </>
              )}
            </View>
          );
        })}
      </View>
    </Block>
  );

  const paidPanel = (
    <Block
      title="Email & paid promotion setup"
      detail="Not integrated in this build. Add a setup checklist to your brief or review official documentation. These actions do not connect an account, send a campaign, start an ad or change any free plan."
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {marketingTools.map((tool) => {
          const selected = brief.tools.includes(tool.id);
          return (
            <View
              key={tool.id}
              style={{
                flexBasis: desktop ? 420 : "100%",
                flexGrow: 1,
                minWidth: 0,
                padding: 16,
                gap: 10,
                borderWidth: 1,
                borderColor: selected ? color.purple : color.border,
                borderRadius: 10,
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${openTool === tool.id ? "Collapse" : "Expand"} ${tool.name} setup`}
                accessibilityState={{ expanded: openTool === tool.id }}
                onPress={() => setOpenTool(openTool === tool.id ? null : tool.id)}
                style={[styles.between, { minHeight: 32 }]}
              >
                <Text style={styles.label}>{tool.name}</Text>
                {openTool === tool.id ? (
                  <Minus size={18} color={color.lime} />
                ) : (
                  <Plus size={18} color={color.muted} />
                )}
              </Pressable>
              <Text style={[styles.eyebrow, { color: color.muted }]}>
                NOT INTEGRATED · {tool.kind}
              </Text>
              {openTool === tool.id && <Text style={styles.small}>{tool.requirements}</Text>}
              <Pressable
                accessibilityRole="checkbox"
                accessibilityLabel={`Include ${tool.name} setup in promotion brief`}
                accessibilityState={{ checked: selected, disabled: saving }}
                aria-checked={selected}
                disabled={saving}
                onPress={() =>
                  updateBrief({
                    tools: selected
                      ? brief.tools.filter((id) => id !== tool.id)
                      : [...brief.tools, tool.id],
                  })
                }
                style={[styles.row, { paddingVertical: 8 }]}
              >
                <View
                  style={{
                    width: 22,
                    height: 22,
                    borderWidth: 1,
                    borderColor: color.lime,
                    borderRadius: 5,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: selected ? color.purple : "transparent",
                  }}
                >
                  {selected && <Check size={16} color="white" />}
                </View>
                <Text style={[styles.small, { flex: 1, color: color.text }]}>
                  Include setup checklist in my brief
                </Text>
              </Pressable>
              {openTool === tool.id && (
                <Action
                  title="Official setup documentation"
                  icon={ExternalLink}
                  secondary
                  disabled={saving}
                  onPress={() => {
                    void Linking.openURL(tool.docs).catch(() =>
                      setError(
                        "The official documentation could not open. Check your device browser.",
                      ),
                    );
                  }}
                />
              )}
            </View>
          );
        })}
      </View>
      <Notice text="Organic publishing can use existing reviewed workflows. Paid advertising and email delivery require separate backend adapters, provider access and explicit audience/budget approval. Social login does not grant those permissions, and no ad spend is enabled here." />
    </Block>
  );

  const progressPanel = (
    <Block
      title="Campaign progress"
      detail="Open a saved release for its real versions, schedule, approval and delivery receipts."
    >
      {!snapshot ? (
        <Text style={styles.small}>
          {loading ? "Loading campaign records…" : "Sign in or refresh to load campaign records."}
        </Text>
      ) : !snapshot.campaigns.length ? (
        <Text style={styles.small}>
          No release campaigns yet. Prepare an owned saved video above to begin.
        </Text>
      ) : (
        snapshot.campaigns.slice(0, 6).map((campaign) => (
          <View
            key={campaign.id}
            style={{
              gap: 7,
              borderBottomWidth: 1,
              borderColor: color.border,
              paddingBottom: 12,
            }}
          >
            <Text style={styles.label}>{campaign.name}</Text>
            <Text style={styles.small}>
              {campaignLabel(campaign.status)}
              {campaign.schedule_at
                ? ` · ${new Date(campaign.schedule_at).toLocaleString()}`
                : " · Not scheduled"}
            </Text>
            <Text style={styles.small}>
              {campaign.detail ||
                "Open this campaign to inspect its current review and delivery state."}
            </Text>
            <Action
              title={`Review ${campaign.name}`}
              secondary
              disabled={saving}
              onPress={() => navigation.navigate("Campaigns", { campaignId: campaign.id })}
            />
          </View>
        ))
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Action title="All campaigns" secondary onPress={() => navigation.navigate("Campaigns")} />
        <Action
          title="Insights & creator economics"
          secondary
          onPress={() => navigation.navigate("MediaOS", { tab: "Insights" })}
        />
      </View>
    </Block>
  );

  const shortcuts = [
    {
      title: "Campaigns",
      Icon: Clapperboard,
      disabled: !signedIn || saving,
      onPress: () => navigation.navigate("Campaigns", source ? { itemId: source.id } : undefined),
    },
    {
      title: "Calendar",
      Icon: CalendarClock,
      disabled: saving,
      onPress: () => navigation.navigate("Calendar"),
    },
    {
      title: "Networks",
      Icon: Link2,
      disabled: saving,
      onPress: () => navigation.navigate("Connections", { tab: "accounts" }),
    },
    {
      title: "Published",
      Icon: Send,
      disabled: !signedIn || saving,
      onPress: () => navigation.navigate("Publishing", source ? { itemId: source.id } : undefined),
    },
  ];
  const sections = [
    {
      id: "plan",
      title: "Release plan",
      detail: "Prepare, review and distribute",
      Icon: Clapperboard,
      content: workflow,
    },
    {
      id: "media",
      title: "Choose media",
      detail: source?.title || `${sources.length} owned video sources`,
      Icon: FolderOpen,
      content: sourcePicker,
    },
    {
      id: "brief",
      title: "Promotion brief",
      detail: savedProject ? "Saved privately" : brief.name || "Audience, message and goals",
      Icon: Sparkles,
      content: briefEditor,
    },
    {
      id: "networks",
      title: "Network publishing",
      detail: "Accounts and destination readiness",
      Icon: Link2,
      content: organicPanel,
    },
    {
      id: "setup",
      title: "Email & ads",
      detail: `${brief.tools.length} setup checklists selected`,
      Icon: Megaphone,
      content: paidPanel,
    },
    {
      id: "progress",
      title: "Campaign progress",
      detail: snapshot
        ? `${snapshot.campaigns.length} release campaigns`
        : "Schedules and delivery receipts",
      Icon: Send,
      content: progressPanel,
    },
  ];

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.screen}
      contentContainerStyle={desktop ? workspace.page : [styles.page, { gap: 16 }]}
    >
      <View style={styles.between}>
        <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
          <View style={styles.row}>
            <Megaphone size={23} color={color.lime} />
            <Text accessibilityRole="header" style={[styles.heading, { fontSize: 25 }]}>
              Promote
            </Text>
          </View>
          <Text style={styles.small}>Your release, one step at a time.</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh promotion readiness"
          accessibilityState={{ disabled: !signedIn || saving || loading, busy: loading }}
          disabled={!signedIn || saving || loading}
          onPress={() => void load()}
          style={{
            width: 44,
            height: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 22,
            backgroundColor: color.panel,
            borderWidth: 1,
            borderColor: color.border,
          }}
        >
          <RefreshCw size={20} color={color.text} />
        </Pressable>
      </View>
      <View
        accessibilityLabel="Promotion shortcuts"
        style={{ flexDirection: "row", gap: 8, maxWidth: 500 }}
      >
        {shortcuts.map(({ title, Icon, disabled, onPress }) => (
          <Pressable
            key={title}
            accessibilityRole="button"
            accessibilityLabel={title}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onPress}
            style={({ pressed }) => ({
              flex: 1,
              minWidth: 0,
              minHeight: 68,
              paddingVertical: 10,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: color.border,
              backgroundColor: color.panel,
              gap: 6,
              alignItems: "center",
              justifyContent: "center",
              opacity: disabled || pressed ? 0.55 : 1,
            })}
          >
            <Icon size={22} color={color.text} strokeWidth={1.7} />
            <Text
              numberOfLines={1}
              style={{ color: color.text, fontFamily: font.medium, fontSize: 11 }}
            >
              {title}
            </Text>
          </Pressable>
        ))}
      </View>
      {!signedIn && (
        <>
          <Notice text="Sign in for your real campaigns, connected accounts and private projects." />
          <Action title="Sign in to Ziipa" onPress={() => navigation.navigate("Login")} />
        </>
      )}
      {!!error && <Notice error text={error} />}
      {!!notice && <Notice text={notice} />}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {stats.map(([label, value]) => (
          <View
            key={label}
            accessibilityLabel={`${label}: ${value}`}
            style={{ flex: 1, minWidth: 0, paddingVertical: 9, alignItems: "center", gap: 3 }}
          >
            <Text style={{ fontFamily: font.semibold, color: color.lime, fontSize: 19 }}>
              {value}
            </Text>
            <Text
              numberOfLines={2}
              style={[styles.small, { fontSize: 10, textAlign: "center", lineHeight: 13 }]}
            >
              {label}
            </Text>
          </View>
        ))}
      </View>
      <View style={{ gap: 10 }}>
        {sections.map(({ id, title, detail, Icon, content }) => {
          const expanded = openSection === id;
          return (
            <View
              key={id}
              style={{
                borderWidth: 1,
                borderColor: expanded ? color.purple : color.border,
                borderRadius: 18,
                backgroundColor: color.panel,
                overflow: "hidden",
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${title}`}
                accessibilityState={{ expanded }}
                onPress={() => setOpenSection(expanded ? null : id)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  padding: 16,
                  minHeight: 72,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Icon size={22} color={expanded ? color.lime : color.text} strokeWidth={1.7} />
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <Text style={[styles.label, { marginBottom: 0 }]}>{title}</Text>
                  <Text numberOfLines={1} style={[styles.small, { fontSize: 12 }]}>
                    {detail}
                  </Text>
                </View>
                {expanded ? (
                  <Minus size={20} color={color.lime} />
                ) : (
                  <Plus size={20} color={color.muted} />
                )}
              </Pressable>
              {expanded && (
                <View style={{ paddingHorizontal: 10, paddingBottom: 10 }}>{content}</View>
              )}
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}
