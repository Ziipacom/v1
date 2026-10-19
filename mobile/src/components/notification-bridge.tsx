import { useEffect } from "react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useZiipa } from "../provider";
import { nativeNotificationListener } from "../lib/notification-client";
import { notificationOpened } from "../lib/notification-types";
import type { RootStack } from "../lib/types";

/** Only an actual native notification tap navigates; mounting never prompts. */
export function NotificationBridge() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const { session } = useZiipa();
  useEffect(() => {
    let current = true;
    let remove = () => {};
    void nativeNotificationListener((data) => {
      const deliveryId = notificationOpened(data);
      if (current && session && deliveryId)
        navigation.navigate("Notifications", { deliveryId });
    }).then((dispose) => {
      if (current) remove = dispose;
      else dispose();
    });
    return () => {
      current = false;
      remove();
    };
  }, [navigation, session]);
  return null;
}
