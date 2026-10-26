import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import type { ExpoSpeechRecognitionResultEvent } from "expo-speech-recognition";

type SpeechModule =
  typeof import("expo-speech-recognition").ExpoSpeechRecognitionModule;
type Subscription = { remove(): void };
type Options = {
  owner?: string;
  enabled: boolean;
  value: string;
  onChange: (text: string) => void;
  maxLength?: number;
};
type Job = {
  scope: object;
  lease: object;
  module: SpeechModule;
  owner: string;
  base: string;
  started: boolean;
  nativeStarted: boolean;
  stopping: boolean;
  listeners: Subscription[];
  deadline?: ReturnType<typeof setTimeout>;
  stopDeadline?: ReturnType<typeof setTimeout>;
};

export const automationDictationMaxMs = 60000;
export const automationDictationStopGraceMs = 3000;

let cachedModule: SpeechModule | null | undefined;
// Speech recognition is a singleton. A retired capture must acknowledge end
// before another account/capture attaches result listeners to that singleton.
let recognitionLease: object | null = null;

function speechModule() {
  if (cachedModule === undefined) {
    try {
      cachedModule =
        require("expo-speech-recognition").ExpoSpeechRecognitionModule;
    } catch {
      // Expo Go and older development binaries may not contain this module.
      cachedModule = null;
    }
  }
  return cachedModule;
}

function available() {
  try {
    return speechModule()?.isRecognitionAvailable() === true;
  } catch {
    return false;
  }
}

function foreground() {
  return (
    (!AppState.currentState || AppState.currentState === "active") &&
    (typeof document === "undefined" || document.visibilityState !== "hidden")
  );
}

function locale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}

function recognizedDraft(base: string, transcript: string, maximum: number) {
  const speech = transcript.trim().replace(/\s+/g, " ");
  const separator = base && speech && !/\s$/.test(base) ? " " : "";
  let text = (base + separator + speech).slice(0, maximum);
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  return text;
}

function recognitionError(code: string) {
  switch (code) {
    case "not-allowed":
      return "Microphone or speech recognition permission was not granted. You can type your request instead.";
    case "service-not-allowed":
    case "language-not-supported":
      return "Speech recognition is unavailable for this device or language. You can type your request instead.";
    case "network":
      return "Voice input could not connect to the device's speech service. Try again or type your request.";
    case "no-speech":
      return "No speech was recognized. Try again or type your request.";
    case "audio-capture":
      return "The microphone is unavailable. Try again or type your request.";
    default:
      return "Voice input stopped. Review the text or type your request.";
  }
}

/** Dictation edits a draft only. It never sends a message or saves audio. */
export function useAutomationDictation(options: Options) {
  const scope = useMemo(() => ({}), [options.owner, options.enabled]);
  const latest = useRef({ ...options, scope });
  latest.current = { ...options, scope };
  const mounted = useRef(true);
  const active = useRef<Job | null>(null);
  const [state, setState] = useState({
    scope,
    pending: false,
    listening: false,
    error: "",
  });
  const supported = available();
  const update = useCallback(
    (
      target: object,
      next: { pending: boolean; listening: boolean; error: string },
    ) => {
      if (mounted.current && latest.current.scope === target)
        setState({ scope: target, ...next });
    },
    [],
  );
  const current = useCallback(
    (job: Job) =>
      mounted.current &&
      active.current === job &&
      latest.current.scope === job.scope &&
      latest.current.enabled &&
      latest.current.owner === job.owner &&
      foreground(),
    [],
  );

  const retire = useCallback(
    (job: Job, abort: boolean, error = "", showState = true) => {
      if (active.current !== job) return;
      active.current = null;
      clearTimeout(job.deadline);
      clearTimeout(job.stopDeadline);
      job.listeners.forEach((listener) => {
        try {
          listener.remove();
        } catch {
          /* Continue stopping the microphone. */
        }
      });
      job.listeners = [];
      if (recognitionLease === job.lease) {
        if (abort && job.nativeStarted) {
          const lease = job.lease;
          // Keep only an identity-free drain listener, never a transcript listener.
          let drain: Subscription | undefined;
          try {
            drain = job.module.addListener("end", () => {
              if (recognitionLease === lease) recognitionLease = null;
              drain?.remove();
            });
          } catch {
            /* A released module may no longer accept a drain listener. */
          }
          try {
            job.module.abort();
          } catch {
            /* No new capture until end is acknowledged. */
          }
        } else recognitionLease = null;
      }
      if (showState)
        update(job.scope, { pending: false, listening: false, error });
    },
    [update],
  );

  const cancel = useCallback(() => {
    const job = active.current;
    if (job) retire(job, true);
    else
      update(latest.current.scope, {
        pending: false,
        listening: false,
        error: "",
      });
  }, [retire, update]);

  const stop = useCallback(() => {
    const job = active.current;
    if (!job) return;
    if (!job.nativeStarted) {
      retire(job, false);
      return;
    }
    if (!current(job) || job.stopping) return;
    job.stopping = true;
    update(job.scope, { pending: true, listening: false, error: "" });
    job.stopDeadline = setTimeout(
      () => retire(job, true),
      automationDictationStopGraceMs,
    );
    try {
      job.module.stop();
    } catch {
      retire(job, true, recognitionError("unknown"));
    }
  }, [current, retire, update]);

  const start = useCallback(async () => {
    const held = latest.current;
    if (!held.owner || !held.enabled || active.current || !foreground()) return;
    const module = speechModule();
    if (!module || !available()) {
      update(held.scope, {
        pending: false,
        listening: false,
        error:
          "Voice input is unavailable here. You can type your request instead.",
      });
      return;
    }
    if (recognitionLease) {
      update(held.scope, {
        pending: false,
        listening: false,
        error: "Voice input is still stopping. Try again in a moment.",
      });
      return;
    }
    const job: Job = {
      scope: held.scope,
      lease: {},
      module,
      owner: held.owner,
      base: held.value,
      started: false,
      nativeStarted: false,
      stopping: false,
      listeners: [],
    };
    active.current = job;
    recognitionLease = job.lease;
    update(job.scope, { pending: true, listening: false, error: "" });
    job.deadline = setTimeout(
      () =>
        retire(
          job,
          true,
          "Voice input stopped after one minute. Review the text or try again.",
        ),
      automationDictationMaxMs,
    );
    try {
      const permission = await module.requestPermissionsAsync();
      if (!current(job)) {
        if (active.current === job) retire(job, false);
        return;
      }
      if (!permission.granted) {
        retire(job, false, recognitionError("not-allowed"));
        return;
      }
      job.listeners.push(
        module.addListener("start", () => {
          if (!current(job)) return;
          job.started = true;
          update(job.scope, { pending: false, listening: true, error: "" });
        }),
        module.addListener(
          "result",
          (event: ExpoSpeechRecognitionResultEvent) => {
            if (!current(job) || !job.started) return;
            const transcript = event.results[0]?.transcript;
            if (typeof transcript !== "string") return;
            const maximum = Math.min(
              3000,
              Math.max(1, Math.floor(latest.current.maxLength || 3000)),
            );
            const text = recognizedDraft(job.base, transcript, maximum);
            latest.current.onChange(text);
            if (event.isFinal || text.length >= maximum) retire(job, true);
          },
        ),
        module.addListener("error", (event) => {
          if (current(job)) retire(job, true, recognitionError(event.error));
        }),
        module.addListener("nomatch", () => {
          if (current(job)) retire(job, true, recognitionError("no-speech"));
        }),
        module.addListener("end", () => {
          if (current(job)) retire(job, false);
        }),
      );
      if (!current(job)) {
        retire(job, false);
        return;
      }
      job.nativeStarted = true;
      module.start({
        lang: locale(),
        interimResults: true,
        continuous: false,
        maxAlternatives: 1,
        recordingOptions: { persist: false },
      });
    } catch {
      if (current(job)) retire(job, true, recognitionError("unknown"));
    }
  }, [current, retire, update]);

  useEffect(() => {
    cancel();
    return cancel;
  }, [scope, cancel]);
  useEffect(() => {
    mounted.current = true;
    const background = AppState.addEventListener("change", (next) => {
      if (next !== "active") cancel();
    });
    const hidden = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      )
        cancel();
    };
    const blur = () => cancel();
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", hidden);
    if (typeof window !== "undefined") window.addEventListener("blur", blur);
    return () => {
      mounted.current = false;
      background.remove();
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", hidden);
      if (typeof window !== "undefined")
        window.removeEventListener("blur", blur);
      const job = active.current;
      if (job) retire(job, true, "", false);
    };
  }, [cancel, retire]);

  const display =
    state.scope === scope
      ? state
      : { pending: false, listening: false, error: "" };
  return {
    supported,
    pending: display.pending,
    listening: display.listening,
    error: display.error,
    start,
    stop,
    cancel,
  };
}
