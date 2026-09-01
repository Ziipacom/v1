import React, { useEffect } from "react";
import { Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { setAudioModeAsync } from "expo-audio";
import { ZiipaProvider } from "./src/provider";
import { Navigation } from "./src/navigation";
import { ScrollbarStyle } from "./src/components/scrollbar-style";

void SplashScreen.preventAutoHideAsync();
class AppBoundary extends React.Component<
  React.PropsWithChildren,
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <View
        style={{
          flex: 1,
          backgroundColor: "#110D1C",
          justifyContent: "center",
          padding: 30,
          gap: 20,
        }}
      >
        <Text style={{ color: "white", fontSize: 26 }}>
          Ziipa needs a fresh start.
        </Text>
        <Text style={{ color: "#B5A8C7", fontSize: 16 }}>
          Close and reopen the app. Your saved account data stays on the server.
        </Text>
      </View>
    ) : (
      this.props.children
    );
  }
}
export default function App() {
  const [loaded, error] = useFonts({
    Barlow: require("./assets/fonts/barlow-400.ttf"),
    BarlowMedium: require("./assets/fonts/barlow-500.ttf"),
    BarlowSemiBold: require("./assets/fonts/barlow-600.ttf"),
    BarlowBold: require("./assets/fonts/barlow-700.ttf"),
  });
  useEffect(() => {
    if (loaded || error) void SplashScreen.hideAsync();
  }, [loaded, error]);
  useEffect(() => {
    void setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    }).catch(() => {});
  }, []);
  if (!loaded && !error) return null;
  return (
    <AppBoundary>
      <SafeAreaProvider>
        <ScrollbarStyle />
        <StatusBar style="light" />
        <ZiipaProvider>
          <Navigation />
        </ZiipaProvider>
      </SafeAreaProvider>
    </AppBoundary>
  );
}
