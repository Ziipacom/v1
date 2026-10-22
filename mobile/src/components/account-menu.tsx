import { useRef, useState } from "react";
import { Alert, Image, Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  Bell,
  Inbox,
  LogOut,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { useZiipa } from "../provider";
import { useAccountMessages } from "../lib/use-account-messages";
import { useOperationScope } from "../lib/use-operation-scope";
import { useProfileImageSource } from "../lib/profile-image-source";
import type { RootStack } from "../lib/types";
import { color, font, styles } from "../theme";

type Navigation = NativeStackNavigationProp<RootStack>;
type AccountDestination =
  "Profile" | "Inbox" | "NotificationMessages" | "Login";
type Props =
  | { navigation: Navigation; onNavigate?: never }
  | { navigation?: never; onNavigate: (name: AccountDestination) => void };

function useAccountSignOut(onError?: (message: string) => void) {
  const { session, logout } = useZiipa();
  const capture = useOperationScope(session?.access_token || "guest");
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function signOut() {
    if (!session || pending.current) return;
    pending.current = true;
    const valid = capture();
    setBusy(true);
    setError("");
    try {
      // The provider revokes this session before clearing local credentials.
      // A failed request leaves the account intact so the user can retry.
      await logout();
    } catch (cause) {
      if (!valid()) return;
      const message =
        cause instanceof Error
          ? cause.message
          : "Couldn’t sign out. Check your connection and try again.";
      setError(message);
      onError?.(message);
    } finally {
      pending.current = false;
      if (valid()) setBusy(false);
    }
  }
  return { signOut, busy, error };
}

/** A compact account control shared by the mobile Discover and Studio headers. */
export function AccountMenu(props: Props) {
  const { session } = useZiipa();
  return (
    <ScopedAccountMenu key={session?.access_token || "guest"} {...props} />
  );
}

function ScopedAccountMenu(props: Props) {
  const { session, guest, data } = useZiipa();
  const { unreadNotifications, refresh } = useAccountMessages();
  const { signOut, busy, error } = useAccountSignOut();
  const [open, setOpen] = useState(false);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const avatar = data.profile?.avatar_url;
  const avatarSource = useProfileImageSource(avatar, session?.access_token);
  const insets = useSafeAreaInsets();
  const hasNewNotifications = (unreadNotifications ?? 0) > 0;
  const initial = Array.from(
    session?.user.name.trim() || "Z",
  )[0].toLocaleUpperCase();
  function close() {
    setOpen(false);
  }
  function navigate(name: AccountDestination) {
    if (props.onNavigate) props.onNavigate(name);
    else props.navigation.navigate(name);
  }
  function go(name: "Profile" | "Inbox" | "NotificationMessages") {
    close();
    navigate(name);
  }
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          session && !guest
            ? `Open account menu for ${session.user.name}`
            : "Sign in to Ziipa"
        }
        accessibilityState={{ expanded: open }}
        onPress={() => {
          if (!session || guest) {
            navigate("Login");
            return;
          }
          setOpen(true);
          void refresh();
        }}
        style={({ pressed }) => ({
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: color.purple,
          borderWidth: 1,
          borderColor: color.border,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        {session && !guest ? (
          avatar && avatarSource && failedAvatar !== avatar ? (
            <Image
              source={avatarSource}
              onError={() => setFailedAvatar(avatar)}
              resizeMode="cover"
              style={{ width: 42, height: 42, borderRadius: 21 }}
            />
          ) : (
            <Text
              style={{
                color: "white",
                fontFamily: font.semibold,
                fontSize: 18,
              }}
            >
              {initial}
            </Text>
          )
        ) : (
          <UserRound color="white" size={22} />
        )}
      </Pressable>
      <Modal
        visible={open && !!session && !guest}
        transparent
        animationType="fade"
        onRequestClose={close}
      >
        <View style={{ flex: 1, backgroundColor: "#0005" }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close account menu"
            onPress={close}
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
            }}
          />
          <View
            accessibilityViewIsModal
            style={{
              position: "absolute",
              top: insets.top + 66,
              right: 16,
              width: 282,
              maxWidth: "90%",
              borderRadius: 18,
              backgroundColor: color.bg,
              borderWidth: 1,
              borderColor: color.border,
              padding: 12,
              elevation: 16,
              boxShadow: "0 10px 35px #0005",
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingLeft: 4,
                marginBottom: 8,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text
                  numberOfLines={1}
                  style={{
                    color: color.text,
                    fontFamily: font.semibold,
                    fontSize: 17,
                  }}
                >
                  {session?.user.name}
                </Text>
                <Text style={[styles.small, { fontSize: 11 }]}>
                  Your Ziipa account
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close account menu"
                onPress={close}
                style={{
                  width: 44,
                  height: 44,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <X color={color.muted} size={20} />
              </Pressable>
            </View>
            <MenuRow
              label="Profile page"
              Icon={UserRound}
              onPress={() => go("Profile")}
            />
            <MenuRow label="Inbox" Icon={Inbox} onPress={() => go("Inbox")} />
            <MenuRow
              label="Notifications"
              Icon={Bell}
              hasNew={hasNewNotifications}
              onPress={() => go("NotificationMessages")}
            />
            <View
              style={{
                height: 1,
                backgroundColor: color.border,
                marginVertical: 8,
              }}
            />
            <MenuRow
              label={busy ? "Signing out…" : "Sign out"}
              Icon={LogOut}
              disabled={busy}
              onPress={() => void signOut()}
            />
            {!!error && (
              <Text
                accessibilityRole="alert"
                style={[styles.error, { fontSize: 12, padding: 6 }]}
              >
                {error}
              </Text>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}

function MenuRow({
  label,
  Icon,
  hasNew = false,
  disabled = false,
  onPress,
}: {
  label: string;
  Icon: LucideIcon;
  hasNew?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hasNew ? `${label}, new notifications` : label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 52,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 12,
        borderRadius: 10,
        backgroundColor: pressed ? color.panel : "transparent",
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <View
        style={{
          width: 25,
          height: 28,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon color={color.text} size={21} strokeWidth={1.7} />
        {hasNew && (
          <View
            accessible={false}
            style={{
              position: "absolute",
              width: 9,
              height: 9,
              right: -1,
              top: 1,
              backgroundColor: "#38C96A",
              borderRadius: 5,
              borderWidth: 1.5,
              borderColor: color.bg,
            }}
          />
        )}
      </View>
      <Text
        style={{
          color: color.text,
          fontFamily: font.medium,
          fontSize: 15,
          flex: 1,
        }}
      >
        {label}
      </Text>
      {hasNew && (
        <Text
          style={{ color: "#38C96A", fontFamily: font.semibold, fontSize: 11 }}
        >
          New
        </Text>
      )}
    </Pressable>
  );
}

/** Profile’s explicit sign-out affordance; failures never silently clear data. */
export function SignOutButton() {
  const { session, guest } = useZiipa();
  const { busy, signOut } = useAccountSignOut((message) =>
    Alert.alert("Couldn’t sign out", message),
  );
  if (!session || guest) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={busy ? "Signing out" : "Sign out"}
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={() => void signOut()}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: "#0B0814B8",
        alignItems: "center",
        justifyContent: "center",
        opacity: busy || pressed ? 0.55 : 1,
      })}
    >
      <LogOut color="white" size={22} strokeWidth={1.7} />
    </Pressable>
  );
}
