import { Pressable, Text, View } from "react-native";
import {
  LayoutGrid,
  Pencil,
  SquarePlus,
  Megaphone,
  Wallet,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStack } from "../lib/types";
import { color, font } from "../theme";
import { useDesktopLayout } from "./desktop-layout";
export function StudioDock() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const { desktop } = useDesktopLayout();
  if (desktop) return null;
  return (
    <View
      style={{
        height: 78 + Math.max(insets.bottom, 10),
        paddingBottom: Math.max(insets.bottom, 10),
        borderTopLeftRadius: 25,
        borderTopRightRadius: 25,
        borderWidth: 1,
        borderColor: color.border,
        backgroundColor: color.dock,
        flexDirection: "row",
        alignItems: "center",
      }}
    >
      {[
        {
          label: "Dashboard",
          Icon: LayoutGrid,
          action: () => navigation.navigate("Profile"),
        },
        {
          label: "Edit",
          Icon: Pencil,
          action: () => navigation.navigate("Studio", { edit: true }),
        },
        {
          label: "Add",
          Icon: SquarePlus,
          action: () => navigation.navigate("Composer"),
        },
        {
          label: "Promote",
          Icon: Megaphone,
          action: () => navigation.navigate("Utility", { kind: "promote" }),
        },
        { label: "Wallet", Icon: Wallet, action: () => {} },
      ].map(({ label, Icon, action }) => (
        <Pressable
          key={label}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ selected: label === "Wallet" }}
          onPress={action}
          style={{
            flex: 1,
            minHeight: 64,
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
          }}
        >
          <Icon
            size={25}
            strokeWidth={1.5}
            color={label === "Wallet" ? color.text : color.faint}
          />
          <Text
            style={{
              fontFamily: font.regular,
              fontSize: 12,
              color: label === "Wallet" ? color.text : color.faint,
            }}
          >
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
