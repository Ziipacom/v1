import { ActivityIndicator, Text } from "react-native";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { useZiipa } from "./provider";
import { color, font, styles } from "./theme";
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
              options={{ title: "Connected networks" }}
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
