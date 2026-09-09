import { ActivityIndicator, Text } from "react-native";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { useZiipa } from "./provider";
import { color, font, styles } from "./theme";
import { portalMode } from "./lib/config";
import { Action, Logo, Notice } from "./components/ui";
import type { RootStack } from "./lib/types";
import { WelcomeScreen, LoginScreen } from "./screens/auth";
import { DiscoverScreen } from "./screens/discovery";
import { StudioScreen } from "./screens/studio";
import { ProfileScreen } from "./screens/profile";
import { WatchScreen } from "./screens/watch";
import { UtilityScreen } from "./screens/utility";
import { FeedsScreen } from "./screens/feeds";
import { ComposerScreen } from "./screens/editor";
import { ConnectionsScreen } from "./screens/connections";
import { PublishingScreen } from "./screens/publishing";
import { ExportsScreen } from './screens/exports';
import { LiveScreen } from "./screens/live";
import { PostScreen } from "./screens/post";
import {
  LegalScreen,
  ModerationScreen,
  SettingsScreen,
} from "./screens/settings";

const Stack = createNativeStackNavigator<RootStack>();
export function Navigation() {
  const { loading, session, guest, error, restore, forgetSession } = useZiipa();
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
      key={
        session ? `member-${session.user.id}` : guest ? "guest" : "signed-out"
      }
      theme={{
        ...DarkTheme,
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
      <Stack.Navigator
        initialRouteName={portalMode ? "Studio" : undefined}
        screenOptions={{
          headerStyle: { backgroundColor: color.bg },
          headerTintColor: color.text,
          headerTitleStyle: { fontFamily: font.medium, fontSize: 18 },
          contentStyle: { backgroundColor: color.bg },
          headerShadowVisible: false,
          animation: "slide_from_right",
        }}
      >
        {session || guest ? (
          <>
            <Stack.Screen
              name="Main"
              component={DiscoverScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Watch"
              component={WatchScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Studio"
              component={StudioScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Profile"
              component={ProfileScreen}
              options={{ headerShown: false }}
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
                headerShown: route.params.kind !== "wallet",
              })}
            />
            <Stack.Screen
              name="Composer"
              component={ComposerScreen}
              options={{ title: "Creator Studio", presentation: "modal" }}
            />
            <Stack.Screen
              name="Connections"
              component={ConnectionsScreen}
              options={{ title: "Your networks" }}
            />
            <Stack.Screen name="Exports" component={ExportsScreen} options={{title:'Rendered exports'}} />
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
          </>
        )}
        <Stack.Screen
          name="Legal"
          component={LegalScreen}
          options={{ title: "Trust & community" }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
