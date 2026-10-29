import { useCallback, useMemo, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { useZiipa } from "../provider";
import { discoveryConnectionIdentity } from "./discovery-feed";
import type { ProfileCollections } from "./profile-collections";

export function useProfileCollections(creatorId?: number) {
  const { api, session, guest, data } = useZiipa();
  const connectionKey = discoveryConnectionIdentity(data.connections);
  const identity = useMemo(
    () => ({}),
    [session?.access_token, guest, creatorId, connectionKey],
  );
  const [receipt, setReceipt] = useState<{
    identity: object;
    value?: ProfileCollections;
    error?: string;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      if (!guest && session) {
        void api<ProfileCollections>(
          creatorId
            ? `/api/creator/profiles/${creatorId}`
            : "/api/creator/profile/collections",
        )
          .then((value) => {
            if (active) setReceipt({ identity, value });
          })
          .catch(() => {
            if (active)
              setReceipt({
                identity,
                error:
                  "This profile collection could not load. Refresh to try again.",
              });
          });
      }
      return () => {
        active = false;
      };
    }, [api, identity, revision]),
  );
  return {
    value: receipt?.identity === identity ? receipt.value : undefined,
    error: receipt?.identity === identity ? receipt.error : undefined,
    loading: !!session && !guest && receipt?.identity !== identity,
    reload: () => setRevision((value) => value + 1),
  };
}
