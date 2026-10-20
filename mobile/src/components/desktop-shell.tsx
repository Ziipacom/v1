import {
  createElement,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ArrowUpRight,
  Bell,
  Bookmark,
  CalendarDays,
  ChartColumn,
  ChevronRight,
  Clapperboard,
  Compass,
  FolderOpen,
  Images,
  LayoutDashboard,
  MailOpen,
  Menu,
  Network,
  Plus,
  Pencil,
  Radio,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  Wallet,
  Workflow,
  type LucideIcon,
} from "lucide-react-native";
import { Logo } from "./ui";
import { useDesktopLayout } from "./desktop-layout";
import { useZiipa } from "../provider";
import {
  adminRoot,
  canAdmin,
  isAdminIdentity,
  type AdminIdentity,
} from "../lib/admin-api";
import { color, font } from "../theme";
import type { RootStack } from "../lib/types";

export type DesktopRoute = {
  name: keyof RootStack;
  params?: Record<string, unknown>;
};
type Navigate = (
  name: keyof RootStack,
  params?: Record<string, unknown>,
) => void;
type NavItem = {
  label: string;
  Icon: LucideIcon;
  name: keyof RootStack;
  params?: Record<string, unknown>;
  active: boolean;
  count?: number;
};

function NavButton({
  item,
  collapsed,
  navigate,
}: {
  item: NavItem;
  collapsed: boolean;
  navigate: Navigate;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.label}
      accessibilityState={{ selected: item.active }}
      onPress={() => navigate(item.name, item.params)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        minHeight: 43,
        borderRadius: 11,
        paddingHorizontal: collapsed ? 12 : 13,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: collapsed ? "center" : "flex-start",
        gap: 11,
        backgroundColor: item.active
          ? "#5420AB45"
          : hovered
            ? "#FFFFFF09"
            : "transparent",
        borderWidth: 1,
        borderColor: item.active ? "#7547B65E" : "transparent",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <item.Icon
        size={19}
        color={item.active ? color.lime : "#B6A9C8"}
        strokeWidth={1.7}
      />
      {!collapsed && (
        <Text
          style={{
            fontFamily: item.active ? font.semibold : font.regular,
            color: item.active ? color.text : "#C3B8D0",
            fontSize: 14,
            flex: 1,
          }}
        >
          {item.label}
        </Text>
      )}
      {!collapsed && item.count !== undefined && item.count > 0 && (
        <Text
          style={{
            color: color.muted,
            fontSize: 11,
            fontFamily: font.medium,
            paddingHorizontal: 7,
            paddingVertical: 2,
            borderRadius: 6,
            backgroundColor: "#FFFFFF0B",
          }}
        >
          {item.count}
        </Text>
      )}
    </Pressable>
  );
}

export function DesktopShell({
  children,
  route,
  navigate,
  enabled,
}: PropsWithChildren<{
  route: DesktopRoute;
  navigate: Navigate;
  enabled: boolean;
}>) {
  const { desktop, measureContent } = useDesktopLayout();
  const { session, guest, api, data, refreshing, refresh } = useZiipa();
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState("");
  const input = useRef<TextInput>(null);
  const [administration, setAdministration] = useState<AdminIdentity | null>(
    null,
  );
  const explore =
    ["Main", "Watch", "Feeds"].includes(route.name) ||
    (route.name === "Live" && route.params?.tab !== "broadcast");
  const params = route.params || {};
  const library = route.name === "CreatorStudio" && params.tab === "library";

  useEffect(() => {
    if (route.name === "Main" || route.name === "CreatorStudio")
      setQuery(typeof params.query === "string" ? params.query : "");
  }, [route.name, params.query]);
  useEffect(() => {
    if (!desktop || !enabled || Platform.OS !== "web") return;
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [desktop, enabled]);
  useEffect(() => {
    let active = true;
    setAdministration(null);
    if (desktop && enabled && session) {
      void api<AdminIdentity>(`${adminRoot}/me`)
        .then((identity) => {
          if (
            active &&
            isAdminIdentity(identity) &&
            identity.user_id === session.user.id
          )
            setAdministration(identity);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [desktop, enabled, session?.access_token, api, route.name]);

  const chrome = desktop && enabled;
  const links: NavItem[] = explore
    ? [
        {
          label: "Discover",
          Icon: Compass,
          name: "Main",
          active: route.name === "Main" && params.collection !== "saved",
        },
        {
          label: "Saved",
          Icon: Bookmark,
          name: "Main",
          params: { collection: "saved" },
          active: route.name === "Main" && params.collection === "saved",
        },
        {
          label: "Live now",
          Icon: Radio,
          name: "Live",
          params: { tab: "watch" },
          active: route.name === "Live",
        },
        {
          label: "Custom feeds",
          Icon: SlidersHorizontal,
          name: "Feeds",
          active: route.name === "Feeds",
        },
      ]
    : [
        {
          label: "Overview",
          Icon: LayoutDashboard,
          name: "CreatorStudio",
          params: { tab: "overview" },
          active:
            (route.name === "CreatorStudio" && !library) ||
            route.name === "Studio",
        },
        {
          label: "Media library",
          Icon: FolderOpen,
          name: "CreatorStudio",
          params: { tab: "library" },
          active: library,
          count: data.drafts.length,
        },
        {
          label: "Calendar",
          Icon: CalendarDays,
          name: "Calendar",
          active: route.name === "Calendar",
        },
        {
          label: "Campaigns",
          Icon: Send,
          name: "Campaigns",
          active:
            route.name === "Campaigns" ||
            (route.name === "Utility" && params.kind === "promote"),
        },
        {
          label: "Recordings & clips",
          Icon: Clapperboard,
          name: "Recordings",
          active: route.name === "Recordings" || route.name === "Exports",
        },
        {
          label: "Connected networks",
          Icon: Network,
          name: "Connections",
          active: route.name === "Connections",
        },
        {
          label: "Publishing",
          Icon: ArrowUpRight,
          name: "Publishing",
          active: route.name === "Publishing",
        },
      ];
  if (!explore) {
    links.splice(1, 0, {
      label: "Editor",
      Icon: Pencil,
      name: "Composer",
      active: route.name === "Composer",
    });
    links.push({
      label: "Gallery",
      Icon: Images,
      name: "Main",
      active: false,
    });
  }
  const osLinks: NavItem[] = [
    {
      label: "Assistant",
      Icon: Sparkles,
      name: "MediaOS",
      params: { tab: "Assistant" },
      active: route.name === "MediaOS" && params.tab === "Assistant",
    },
    {
      label: "Workflows",
      Icon: Workflow,
      name: "MediaOS",
      params: { tab: "Workflows" },
      active: route.name === "MediaOS" && params.tab === "Workflows",
    },
    {
      label: "Insights",
      Icon: ChartColumn,
      name: "MediaOS",
      params: { tab: "Insights" },
      active: route.name === "MediaOS" && params.tab === "Insights",
    },
    {
      label: "Your Media OS",
      Icon: LayoutDashboard,
      name: "MediaOS",
      active:
        route.name === "MediaOS" &&
        !["Assistant", "Workflows", "Insights"].includes(String(params.tab)),
    },
  ];
  const account: NavItem[] = [
    {
      label: "Wallet & rewards",
      Icon: Wallet,
      name: "Utility",
      params: { kind: "wallet" },
      active: route.name === "Utility" && params.kind === "wallet",
    },
    {
      label: "Your profile",
      Icon: UserRound,
      name: "Profile",
      active: route.name === "Profile",
    },
    {
      label: "Inbox",
      Icon: MailOpen,
      name: "Utility",
      params: { kind: "inbox" },
      active: route.name === "Utility" && params.kind === "inbox",
    },
    ...(session
      ? [
          {
            label: "Settings",
            Icon: Settings,
            name: "Settings" as const,
            active: route.name === "Settings",
          },
        ]
      : []),
    ...(canAdmin(administration, "overview.read")
      ? [
          {
            label: "Administration",
            Icon: ShieldCheck,
            name: "Administration" as const,
            active: route.name === "Administration",
          },
        ]
      : []),
  ];
  const group = (title: string, items: NavItem[]) => (
    <View style={{ gap: 4, marginBottom: 23 }}>
      {!collapsed && (
        <Text
          style={{
            color: "#82748F",
            fontFamily: font.medium,
            fontSize: 10,
            letterSpacing: 1.6,
            paddingHorizontal: 14,
            marginBottom: 7,
          }}
        >
          {title}
        </Text>
      )}
      {items.map((item) => (
        <NavButton
          key={item.label}
          item={item}
          collapsed={collapsed}
          navigate={navigate}
        />
      ))}
    </View>
  );
  const submitSearch = () =>
    navigate(
      explore ? "Main" : "CreatorStudio",
      explore
        ? { query: query.trim() }
        : { tab: "library", query: query.trim() },
    );

  // Keep the navigator's ancestors stable across resize. Re-parenting the stack
  // would discard an editor draft or stop a capture at the desktop breakpoint.
  return (
    <View
      nativeID={chrome ? "ziipa-desktop-portal" : undefined}
      style={{
        flex: 1,
        flexDirection: "row",
        backgroundColor: color.bg,
        minHeight: 0,
      }}
    >
      {chrome &&
        Platform.OS === "web" &&
        createElement(
          "style",
          null,
          "#ziipa-desktop-portal :focus-visible{outline:2px solid #A6E21B!important;outline-offset:3px}#ziipa-desktop-portal input:focus-visible{outline-offset:0}@media(prefers-reduced-motion:reduce){#ziipa-desktop-portal *{scroll-behavior:auto!important;animation:none!important;transition:none!important}}",
        )}
      {chrome && (
        <View
          key="sidebar"
          role="navigation"
          accessibilityLabel="Ziipa primary navigation"
          style={{
            width: collapsed ? 76 : 240,
            borderRightWidth: 1,
            borderColor: "#2B2239",
            backgroundColor: "#100B1B",
            paddingHorizontal: collapsed ? 9 : 13,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Ziipa Explore home"
            onPress={() => navigate("Main")}
            style={{
              height: 77,
              justifyContent: "center",
              paddingHorizontal: collapsed ? 3 : 13,
            }}
          >
            <Logo width={collapsed ? 52 : 112} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create new media"
            onPress={() => navigate("Composer")}
            style={({ pressed }) => ({
              backgroundColor: color.purple,
              borderRadius: 11,
              minHeight: 43,
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "row",
              gap: 9,
              marginBottom: 25,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Plus size={20} color="white" />
            {!collapsed && (
              <Text
                style={{
                  color: color.text,
                  fontFamily: font.semibold,
                  fontSize: 14,
                }}
              >
                Create
              </Text>
            )}
          </Pressable>
          <ScrollView
            showsVerticalScrollIndicator={false}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 18 }}
          >
            {group(explore ? "EXPLORE" : "CREATOR STUDIO", links)}
            {!explore && group("PERSONAL MEDIA OS", osLinks)}
            {group("YOUR SPACE", account)}
          </ScrollView>
          {!collapsed && (
            <View
              style={{
                padding: 13,
                gap: 5,
                borderTopWidth: 1,
                borderColor: "#2B2239",
                marginBottom: 10,
              }}
            >
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 7 }}
              >
                <View
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 3,
                    backgroundColor: guest ? color.muted : color.lime,
                  }}
                />
                <Text
                  style={{
                    color: color.muted,
                    fontSize: 11,
                    fontFamily: font.medium,
                  }}
                >
                  {guest ? "Sample workspace" : "Signed in to Ziipa"}
                </Text>
              </View>
              <Text
                style={{
                  color: "#786D87",
                  fontSize: 10,
                  fontFamily: font.regular,
                }}
              >
                One library. Across your devices.
              </Text>
            </View>
          )}
        </View>
      )}
      <View key="workspace" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        {chrome && (
          <View
            key="topbar"
            style={{
              height: 77,
              borderBottomWidth: 1,
              borderColor: "#2B2239",
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 24,
              gap: 20,
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                collapsed
                  ? "Expand desktop sidebar"
                  : "Collapse desktop sidebar"
              }
              accessibilityState={{ expanded: !collapsed }}
              onPress={() => setCollapsed((value) => !value)}
              style={{ padding: 7 }}
            >
              <Menu color={color.muted} size={21} />
            </Pressable>
            <View
              accessibilityRole="tablist"
              style={{
                flexDirection: "row",
                backgroundColor: "#1A1327",
                borderRadius: 10,
                padding: 4,
                gap: 3,
              }}
            >
              {(["Explore", "Creator Studio"] as const).map((title, index) => (
                <Pressable
                  key={title}
                  accessibilityRole="tab"
                  accessibilityState={{
                    selected: index === 0 ? explore : !explore,
                  }}
                  onPress={() =>
                    navigate(index === 0 ? "Main" : "CreatorStudio")
                  }
                  style={{
                    paddingHorizontal: 15,
                    paddingVertical: 8,
                    borderRadius: 7,
                    backgroundColor: (index === 0 ? explore : !explore)
                      ? "#35224B"
                      : "transparent",
                  }}
                >
                  <Text
                    style={{
                      color: (index === 0 ? explore : !explore)
                        ? color.text
                        : color.muted,
                      fontFamily: font.medium,
                      fontSize: 13,
                    }}
                  >
                    {title}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View
              style={{
                flex: 1,
                maxWidth: 480,
                marginLeft: "auto",
                flexDirection: "row",
                alignItems: "center",
                gap: 9,
                borderWidth: 1,
                borderColor: "#342A44",
                borderRadius: 10,
                backgroundColor: "#1A1425",
                paddingHorizontal: 12,
                height: 39,
              }}
            >
              <Search color="#9E8EAF" size={17} />
              <TextInput
                ref={input}
                accessibilityLabel={
                  explore ? "Search Ziipa creations" : "Search all your media"
                }
                value={query}
                onChangeText={(text) => setQuery(text.slice(0, 160))}
                onSubmitEditing={submitSearch}
                placeholder={
                  explore
                    ? "Search creations, creators, tags…"
                    : "Search your media library…"
                }
                placeholderTextColor="#8C7B9F"
                style={{
                  flex: 1,
                  minWidth: 50,
                  height: 37,
                  color: color.text,
                  fontFamily: font.regular,
                  fontSize: 13,
                }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Run search"
                onPress={submitSearch}
              >
                <ChevronRight color={color.muted} size={16} />
              </Pressable>
              <Text
                style={{
                  color: "#786988",
                  fontFamily: font.regular,
                  fontSize: 10,
                }}
              >
                Ctrl K
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh workspace"
              accessibilityState={{ busy: refreshing }}
              disabled={refreshing}
              onPress={() => void refresh()}
              style={{ padding: 5, opacity: refreshing ? 0.5 : 1 }}
            >
              <RefreshCw size={17} color={color.muted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Private updates and notifications"
              onPress={() => navigate("Notifications")}
              style={{ padding: 5 }}
            >
              <Bell size={19} color={color.muted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open your account profile"
              onPress={() => navigate("Profile")}
              style={{
                width: 35,
                height: 35,
                borderRadius: 18,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "#47256B",
                borderWidth: 1,
                borderColor: "#79549C",
              }}
            >
              <Text
                style={{
                  color: color.text,
                  fontFamily: font.semibold,
                  fontSize: 14,
                }}
              >
                {(session?.user.name?.trim() || "Ziipa")
                  .slice(0, 1)
                  .toUpperCase()}
              </Text>
            </Pressable>
          </View>
        )}
        <View
          key="screens"
          style={{ flex: 1, minWidth: 0, minHeight: 0 }}
          onLayout={(event) => measureContent(event.nativeEvent.layout.width)}
        >
          {children}
        </View>
      </View>
    </View>
  );
}
