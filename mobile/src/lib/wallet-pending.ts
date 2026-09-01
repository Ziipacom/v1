import * as SecureStore from "expo-secure-store";
export type Pending = { intentId: string; hash: string };
export async function readPending(userId: number): Promise<Pending | null> {
  const raw = await SecureStore.getItemAsync(`ziipa.web3.pending.${userId}`);
  return raw ? JSON.parse(raw) : null;
}
export async function savePending(userId: number, value: Pending | null) {
  const key = `ziipa.web3.pending.${userId}`;
  if (value)
    await SecureStore.setItemAsync(key, JSON.stringify(value), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  else await SecureStore.deleteItemAsync(key);
}
