import { useState } from "react";
import {
  ImageBackground,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  Switch,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { ArrowUpRight, Play, Sparkles } from "lucide-react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStack } from "../lib/types";
import { color, font, styles } from "../theme";
import { Action, Field, Logo, Notice } from "../components/ui";
import { useZiipa } from "../provider";
import { demoEnabled } from "../lib/config";

export function WelcomeScreen({
  navigation,
}: NativeStackScreenProps<RootStack, "Welcome">) {
  const { enterGuest } = useZiipa();
  return (
    <View style={styles.screen}>
      <ImageBackground
        source={require("../../assets/media/dj.jpg")}
        style={{ flex: 1 }}
        resizeMode="cover"
      >
        <LinearGradient
          colors={["#110D1C22", "#110D1C66", color.bg]}
          style={{ flex: 1 }}
        >
          <SafeAreaView style={{ flex: 1 }}>
            <View style={{ padding: 25 }}>
              <Logo width={125} />
            </View>
            <View style={{ flex: 1 }} />
            <View style={{ padding: 26, gap: 22 }}>
              <View style={styles.row}>
                <Sparkles color={color.lime} size={16} />
                <Text style={styles.eyebrow}>
                  ONE WORLD. ENDLESS POSSIBILITIES.
                </Text>
              </View>
              <Text style={[styles.title, { fontSize: 48, lineHeight: 50 }]}>
                A world{"\n"}of <Text style={{ color: "#BA92FF" }}>yours.</Text>
              </Text>
              <Text style={styles.body}>
                Find your people. Share your creativity. Explore video, music,
                and your next obsession.
              </Text>
              <Action
                title="Get started"
                icon={ArrowUpRight}
                onPress={() => navigation.navigate("Login", { register: true })}
              />
              <Action
                secondary
                title="I already have an account"
                onPress={() =>
                  navigation.navigate("Login", { register: false })
                }
              />
              {demoEnabled && (
                <Pressable
                  accessibilityRole="button"
                  onPress={enterGuest}
                  style={[
                    styles.row,
                    { justifyContent: "center", minHeight: 44 },
                  ]}
                >
                  <Play size={15} color={color.muted} />
                  <Text style={styles.small}>Explore the sample app</Text>
                </Pressable>
              )}
              <Text
                style={[styles.small, { textAlign: "center", fontSize: 11 }]}
              >
                Your Ziipa account works across the portal and mobile app.
              </Text>
            </View>
          </SafeAreaView>
        </LinearGradient>
      </ImageBackground>
    </View>
  );
}
export function LoginScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStack, "Login">) {
  const [register, setRegister] = useState(route.params?.register ?? false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [adult, setAdult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { authenticate } = useZiipa();
  async function submit() {
    if (register && (!accepted || !adult)) {
      setError(
        "Confirm your age and accept the community rules and terms to continue.",
      );
      return;
    }
    if (
      !email.trim() ||
      !password ||
      (register && (!name.trim() || password.length < 12))
    ) {
      setError(
        "Enter your details. New passwords need at least 12 characters.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      await authenticate(email, password, register ? name : undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.page}
      >
        <Logo width={137} />
        <View style={{ gap: 12, marginVertical: 13 }}>
          <Text style={styles.eyebrow}>YOUR CREATIVE SPACE</Text>
          <Text style={styles.title}>
            {register ? "Make room\nfor you." : "Welcome\nback."}
          </Text>
          <Text style={styles.body}>
            {register
              ? "One account for every side of your creativity."
              : "Sign in with the account you use in the Ziipa portal."}
          </Text>
        </View>
        {register && (
          <Field
            label="Your name"
            value={name}
            onChangeText={setName}
            maxLength={100}
            autoComplete="name"
            editable={!busy}
          />
        )}
        <Field
          label="Email address"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          textContentType="emailAddress"
          maxLength={320}
          editable={!busy}
        />
        <Field
          label={register ? "Password · at least 12 characters" : "Password"}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType={register ? "newPassword" : "password"}
          autoComplete={register ? "new-password" : "current-password"}
          autoCapitalize="none"
          maxLength={128}
          editable={!busy}
        />
        {register && (
          <View style={{ gap: 15 }}>
            <View style={styles.between}>
              <Text style={[styles.small, { flex: 1 }]}>
                I am 18 or older. This first release is for adults.
              </Text>
              <Switch
                accessibilityLabel="I am 18 or older"
                value={adult}
                onValueChange={setAdult}
                trackColor={{ true: color.purple }}
                disabled={busy}
              />
            </View>
            <View style={styles.between}>
              <Text style={[styles.small, { flex: 1 }]}>
                I accept the terms and community rules, and have read the
                privacy information.
              </Text>
              <Switch
                accessibilityLabel="Accept terms and community rules"
                value={accepted}
                onValueChange={setAccepted}
                trackColor={{ true: color.purple }}
                disabled={busy}
              />
            </View>
            <View style={[styles.row, { flexWrap: "wrap" }]}>
              {(["terms", "privacy", "community"] as const).map((kind) => (
                <Pressable
                  key={kind}
                  onPress={() => navigation.navigate("Legal", { kind })}
                  accessibilityRole="link"
                  style={{ minHeight: 44, justifyContent: "center" }}
                >
                  <Text style={{ color: "#BB94FF", fontFamily: font.medium }}>
                    {kind === "community"
                      ? "Community rules"
                      : kind === "terms"
                        ? "Terms"
                        : "Privacy"}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
        {!!error && <Notice text={error} error />}
        <Action
          testID="auth-submit"
          title={register ? "Create my account" : "Sign in"}
          onPress={() => void submit()}
          busy={busy}
        />
        <Action
          secondary
          title={
            register
              ? "Already a member? Sign in"
              : "New to Ziipa? Create an account"
          }
          onPress={() => {
            setRegister(!register);
            setError("");
          }}
          disabled={busy}
        />
        {__DEV__ && (
          <Notice text="Development build. Connect to your local Ziipa API or a configured staging server. No accounts are created on the live ziipa.com website." />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
