import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text } from "react-native";
import {
  NavigationContainer,
  DarkTheme,
  CommonActions,
  useNavigationContainerRef,
  type LinkingOptions,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { useZiipa } from "./provider";
import { color, font, styles, useTheme } from "./theme";
import { portalMode } from "./lib/config";
import { Action, Logo, Notice } from "./components/ui";
import type { RootStack } from "./lib/types";
import { WelcomeScreen, LoginScreen } from "./screens/auth";
import { DiscoverScreen } from "./screens/discovery";
import { StudioScreen } from "./screens/studio";
import { ProfileScreen } from "./screens/profile";
import { MediaOSScreen } from "./screens/media-os";
import { WatchScreen } from "./screens/watch";
import { UtilityScreen } from "./screens/utility";
import { FeedsScreen } from "./screens/feeds";
import { ComposerScreen } from "./screens/editor";
import { ConnectionsScreen } from "./screens/connections";
import { PublishingScreen } from "./screens/publishing";
import { ExportsScreen } from "./screens/exports";
import { CampaignsScreen } from "./screens/campaigns";
import { CalendarScreen } from "./screens/calendar";
import { LiveScreen } from "./screens/live";
import { RecordingsScreen } from "./screens/recordings";
import { NotificationsScreen } from "./screens/notifications";
import { InboxScreen, NotificationMessagesScreen } from "./screens/account-messages";
import { AdministrationScreen } from "./screens/admin";
import { NotificationBridge } from "./components/notification-bridge";
import { PostScreen } from "./screens/post";
import {
  DesktopLayoutProvider,
  useDesktopLayout,
} from "./components/desktop-layout";
import { DesktopShell, type DesktopRoute } from "./components/desktop-shell";
import { CreatorStudioScreen } from "./screens/desktop-creator";
import {
  destinationFromSearch,
  destinationSearch,
} from "./lib/desktop-navigation";
import { composerRouteId } from "./lib/composer-navigation";
import {
  LegalScreen,
  ModerationScreen,
  SettingsScreen,
} from "./screens/settings";

const Stack = createNativeStackNavigator<RootStack>();
export function Navigation() {
  return (
    <DesktopLayoutProvider>
      <NavigationContent />
    </DesktopLayoutProvider>
  );
}

function StudioRoute(props: NativeStackScreenProps<RootStack, "Studio">) {
  const { desktop } = useDesktopLayout();
  if (!desktop) return <StudioScreen {...props} />;
  return (
    <CreatorStudioScreen
      navigation={
        props.navigation as NativeStackScreenProps<
          RootStack,
          "CreatorStudio"
        >["navigation"]
      }
      route={{
        ...props.route,
        name: "CreatorStudio",
        params: {
          tab: props.route.params?.edit ? "library" : "overview",
          category: props.route.params?.category,
        },
      }}
    />
  );
}

function NavigationContent() {
  const { resolvedMode } = useTheme();
  const { loading, session, guest, error, restore, forgetSession, data } =
    useZiipa();
  const { desktop } = useDesktopLayout();
  const navigation = useNavigationContainerRef<RootStack>();
  const [activeRoute, setActiveRoute] = useState<DesktopRoute>({
    name: "Main",
  });
  const currentData = useRef(data);
  currentData.current = data;
  // React Navigation owns browser history, including rollback of prevented Back
  // actions. Only explicitly allowed IDs and filters are ever put in a URL.
  const linking = useMemo<LinkingOptions<RootStack> | undefined>(() => {
    if (!desktop || typeof window === "undefined") return undefined;
    const base = portalMode ? "/studio/" : window.location.pathname;
    return {
      prefixes: [],
      getStateFromPath(path) {
        const destination = destinationFromSearch(
          path.includes("?") ? path.slice(path.indexOf("?")) : "",
        ) || { screen: "Main", params: undefined };
        let name = destination.screen;
        let params = destination.params ? { ...destination.params } : undefined;
        if (name === "Composer" && typeof params?.draftId === "string") {
          const item = currentData.current.drafts.find(
            (row) => row.id === params?.draftId,
          );
          if (item && item.visibility !== "hidden") params = { item };
          else {
            name = "CreatorStudio";
            params = { tab: "library" };
          }
        }
        return { routes: [{ name, params }] };
      },
      getPathFromState(state) {
        const route = state.routes[state.index ?? state.routes.length - 1];
        return (
          base +
          (destinationSearch(
            route.name,
            route.params as Record<string, unknown> | undefined,
          ) || "?view=studio")
        );
      },
    };
  }, [desktop]);
  const observeRoute = () => {
    const route = navigation.getCurrentRoute();
    if (route)
      setActiveRoute({
        name: route.name,
        params: route.params as Record<string, unknown> | undefined,
      });
  };
  if (loading)
    return (
      <SafeAreaView
        style={[
          styles.screen,
          { alignItems: "center", justifyContent: "center", gap: 25 },
        ]}
      >
        <Logo width={150} />
        <ActivityIndicator color={color.purple} />
      </SafeAreaView>
    );
  if (!session && !guest && error)
    return (
      <SafeAreaView
        style={[styles.screen, styles.page, { justifyContent: "center" }]}
      >
        <Logo width={145} />
        <Text style={styles.title}>Let’s reconnect.</Text>
        <Notice text={error} error />
        <Action title="Try again" onPress={() => void restore()} />
        <Action
          secondary
          title="Forget this device’s session"
          onPress={() => void forgetSession()}
        />
      </SafeAreaView>
    );
  if (portalMode && !session)
    return (
      <SafeAreaView
        style={[
          styles.screen,
          styles.page,
          { justifyContent: "center", gap: 20 },
        ]}
      >
        <Logo width={145} />
        <Text style={styles.title}>Sign in to your Studio</Text>
        <Text style={styles.small}>
          Your website session has ended. Sign in again to continue.
        </Text>
        <Action
          title="Return to portal sign in"
          onPress={() => {
            window.parent.postMessage(
              { source: "ziipa-studio", type: "signed-out" },
              window.location.origin,
            );
            if (window.parent === window) window.location.assign("/portal");
          }}
        />
      </SafeAreaView>
    );
  return (
    <NavigationContainer
      ref={navigation}
      linking={linking}
      onReady={observeRoute}
      onStateChange={observeRoute}
      key={
        session ? `member-${session.user.id}` : guest ? "guest" : "signed-out"
      }
      theme={{
        ...DarkTheme,
        dark: resolvedMode === "dark",
        colors: {
          ...DarkTheme.colors,
          primary: color.purple,
          background: color.bg,
          card: color.bg,
          text: color.text,
          border: color.border,
          notification: color.lime,
        },
      }}
    >
      {session && <NotificationBridge />}
      <DesktopShell
        route={activeRoute}
        enabled={!!(session || guest)}
        navigate={(name, params) => {
          if (navigation.isReady())
            navigation.dispatch(CommonActions.navigate({ name, params }));
        }}
      >
        <Stack.Navigator
          initialRouteName={
            desktop
              ? "Main"
              : portalMode
                ? typeof window !== "undefined" &&
                  new URLSearchParams(window.location.search).get("view") ===
                    "admin"
                  ? "Administration"
                  : "Studio"
                : undefined
          }
          screenOptions={{
            headerShown: !desktop,
            headerStyle: { backgroundColor: color.bg },
            headerTintColor: color.text,
            headerTitleStyle: { fontFamily: font.medium, fontSize: 18 },
            contentStyle: { backgroundColor: color.bg },
            headerShadowVisible: false,
            animation: desktop ? "none" : "slide_from_right",
          }}
        >
          {session || guest ? (
            <>
              <Stack.Screen
                name="Main"
                component={DiscoverScreen}
                options={{
                  headerShown: false,
                  ...(desktop ? { title: "Explore · Ziipa" } : {}),
                }}
              />
              <Stack.Screen
                name="Watch"
                component={WatchScreen}
                options={{ headerShown: false }}
              />
              <Stack.Screen
                name="Studio"
                component={StudioRoute}
                options={{ headerShown: false }}
              />
              <Stack.Screen
                name="CreatorStudio"
                component={CreatorStudioScreen}
                options={{
                  headerShown: false,
                  title: "Creator Studio · Ziipa",
                }}
              />
              <Stack.Screen
                name="Profile"
                component={ProfileScreen}
                options={{ headerShown: false }}
              />
              <Stack.Screen
                name="MediaOS"
                component={MediaOSScreen}
                options={{ title: "Your Media OS" }}
              />
              <Stack.Screen
                name="Feeds"
                component={FeedsScreen}
                options={{ title: "Your feed rules" }}
              />
              <Stack.Screen
                name="Utility"
                component={UtilityScreen}
                options={({ route }) => ({
                  title: "Ziipa Studio",
                  headerShown: !desktop && route.params.kind !== "wallet",
                })}
              />
              <Stack.Screen
                name="Composer"
                component={ComposerScreen}
                getId={composerRouteId}
                options={{
                  title: "Creator Studio",
                  headerShown: true,
                  presentation: desktop ? "card" : "modal",
                }}
              />
              <Stack.Screen
                name="Connections"
                component={ConnectionsScreen}
                options={{ title: "Your networks" }}
              />
              <Stack.Screen
                name="Exports"
                component={ExportsScreen}
                options={{ title: "Rendered exports" }}
              />
              <Stack.Screen
                name="Campaigns"
                component={CampaignsScreen}
                options={{ title: "Creator campaigns" }}
              />
              <Stack.Screen
                name="Calendar"
                component={CalendarScreen}
                options={{ title: "Creator calendar" }}
              />
              <Stack.Screen
                name="Publishing"
                component={PublishingScreen}
                options={{ title: "Publish to your networks" }}
              />
              <Stack.Screen
                name="Live"
                component={LiveScreen}
                options={{ title: "Live broadcasts" }}
              />
              <Stack.Screen
                name="Recordings"
                component={RecordingsScreen}
                options={{ title: "Private recordings & clips" }}
              />
              <Stack.Screen
                name="Notifications"
                component={NotificationsScreen}
                options={{ title: "Private updates" }}
              />
              <Stack.Screen
                name="Inbox"
                component={InboxScreen}
                options={{ title: "Inbox" }}
              />
              <Stack.Screen
                name="NotificationMessages"
                component={NotificationMessagesScreen}
                options={{ title: "Notifications" }}
              />
            </>
          ) : (
            <Stack.Screen
              name="Welcome"
              component={WelcomeScreen}
              options={{ headerShown: false }}
            />
          )}
          {!session && (
            <Stack.Screen
              name="Login"
              component={LoginScreen}
              options={{ title: "Your Ziipa account" }}
            />
          )}
          <Stack.Screen
            name="Post"
            component={PostScreen}
            options={{ title: "Creation details" }}
          />
          {session && (
            <>
              <Stack.Screen
                name="Settings"
                component={SettingsScreen}
                options={{ title: "Your account" }}
              />
              <Stack.Screen
                name="Moderation"
                component={ModerationScreen}
                options={{ title: "Safety operations" }}
              />
              <Stack.Screen
                name="Administration"
                component={AdministrationScreen}
                options={{ title: "Ziipa administration" }}
              />
            </>
          )}
          <Stack.Screen
            name="Legal"
            component={LegalScreen}
            options={{ title: "Trust & community" }}
          />
        </Stack.Navigator>
      </DesktopShell>
    </NavigationContainer>
  );
}
