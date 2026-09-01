import type { Pending } from "./wallet-pending";
export async function readPending(userId: number): Promise<Pending | null> {
  const raw = sessionStorage.getItem(`ziipa.web3.pending.${userId}`);
  return raw ? JSON.parse(raw) : null;
}
export async function savePending(userId: number, value: Pending | null) {
  const key = `ziipa.web3.pending.${userId}`;
  if (value) sessionStorage.setItem(key, JSON.stringify(value));
  else sessionStorage.removeItem(key);
}
