import { useEffect, useRef, useState, type RefObject } from "react";
import { useZiipa } from "../provider";
import type { TitleImageCapture } from "./title-image";
import { suggestedCreationCopy, type CreationCopy } from "./creation-title";

export type CreationAutofill = {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  message: string;
};

/** Runs outside inspector tabs, so selecting media can fill fields while editing. */
export function useCreationAutofill(options: {
  sourceKey: string;
  visual: boolean;
  disabled: boolean;
  needsCopy: boolean;
  capture: RefObject<TitleImageCapture | null>;
  onFill: (copy: CreationCopy) => void;
}): CreationAutofill {
  const { api, session, guest } = useZiipa();
  const owner = session?.access_token || "";
  const [permission, setPermission] = useState<{
    owner: string;
    allowed: boolean;
  } | null>(null);
  const enabled =
    !!owner && !guest && permission?.owner === owner && permission.allowed;
  const [status, setStatus] = useState({
    scope: "",
    message: "",
    pending: false,
  });
  const scope = JSON.stringify([owner, options.sourceKey]);
  const latest = useRef({ ...options, scope, enabled });
  latest.current = { ...options, scope, enabled };
  const attempted = useRef(new Set<string>());
  const running = useRef(new Set<string>());
  const configuration = useRef<{
    owner: string;
    available: boolean;
    descriptionSupported: boolean;
  } | null>(null);
  useEffect(() => {
    attempted.current.clear();
    configuration.current = null;
  }, [owner]);
  useEffect(() => {
    if (
      !enabled ||
      !options.visual ||
      !options.sourceKey ||
      options.disabled ||
      !options.needsCopy ||
      attempted.current.has(scope)
    )
      return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let releaseWait: (() => void) | undefined;
    const current = () =>
      active &&
      latest.current.scope === scope &&
      latest.current.enabled &&
      latest.current.visual &&
      !latest.current.disabled &&
      latest.current.needsCopy;
    const message = (text: string) => {
      if (current()) setStatus({ scope, message: text, pending: true });
    };
    const wait = () =>
      new Promise<void>((resolve) => {
        releaseWait = resolve;
        timer = setTimeout(resolve, 200);
      });
    running.current.add(scope);
    void (async () => {
      try {
        message("Preparing a title and description from your media…");
        for (
          let poll = 0;
          current() && !options.capture.current?.isReady();
          poll++
        ) {
          if (poll >= 50) throw new Error("Media is still loading.");
          await wait();
        }
        if (!current()) return;
        attempted.current.add(scope);
        if (configuration.current?.owner !== owner) {
          const config = await api<{
            available: boolean;
            metadata_version?: number;
          }>("/api/editor/title/config");
          if (!current()) return;
          configuration.current = {
            owner,
            available: config.available === true,
            descriptionSupported: config.metadata_version === 2,
          };
        }
        if (
          !configuration.current.available ||
          !configuration.current.descriptionSupported
        )
          throw new Error("AI autofill is unavailable.");
        const image = await options.capture.current!.capture();
        if (!current()) return;
        const output = await api("/api/editor/title/suggest", {
          image,
          consent: true,
        });
        if (!current()) return;
        latest.current.onFill(suggestedCreationCopy(output));
        setStatus({
          scope,
          message: "AI suggestions added. Review or edit them before saving.",
          pending: false,
        });
      } catch {
        // One attempt per source; no hidden retries or generated filename fallback.
        attempted.current.add(scope);
        if (current())
          setStatus({
            scope,
            pending: false,
            message:
              "AI could not fill these fields. Enter your own title and description.",
          });
      }
    })();
    return () => {
      active = false;
      running.current.delete(scope);
      clearTimeout(timer);
      releaseWait?.();
    };
  }, [
    enabled,
    owner,
    scope,
    options.visual,
    options.disabled,
    options.needsCopy,
    api,
  ]);
  return {
    enabled,
    setEnabled: (allowed) => {
      setStatus({ scope: "", message: "", pending: false });
      setPermission({ owner, allowed });
    },
    message:
      enabled &&
      !options.disabled &&
      status.scope === scope &&
      (!status.pending || running.current.has(scope))
        ? status.message
        : "",
  };
}
