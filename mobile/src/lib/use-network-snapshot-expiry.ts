import { useEffect, useState } from "react";
import { nextDiscoverySnapshotExpiry } from "./discovery-feed";
import type { NetworkHub } from "./network-hub";

/** One local deadline re-render; it never refreshes Ziipa or a provider. */
export function useNetworkSnapshotExpiry(hub: NetworkHub | null): string {
  const [tick, setTick] = useState(0);
  const deadline = nextDiscoverySnapshotExpiry(hub);
  useEffect(() => {
    if (deadline === null) return;
    const timer = setTimeout(
      () => setTick((value) => value + 1),
      Math.max(1, Math.min(86400000, deadline - Date.now() + 1)),
    );
    return () => clearTimeout(timer);
  }, [hub, deadline, tick]);
  // A render after a suspended app resumes also masks elapsed deadlines.
  return `${tick}:${deadline ?? "expired"}`;
}
