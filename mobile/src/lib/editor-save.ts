import type { Bootstrap, Item, ItemInput } from "./types";

export type EditorSaveAction = "draft" | "published";
export type EditorSavePhase =
  | "checking"
  | "upload_source"
  | "upload_soundtrack"
  | "saving"
  | "publishing"
  | "distribution"
  | "refresh";

export function editorSaveLabel(phase: EditorSavePhase, progress = 0) {
  const percent = Math.max(0, Math.min(100, Math.round(progress)));
  return {
    checking: "Checking your creation…",
    upload_source: `Uploading media… ${percent}%`,
    upload_soundtrack: `Uploading soundtrack… ${percent}%`,
    saving: "Saving private draft…",
    publishing: "Publishing to Ziipa…",
    distribution: "Preparing network delivery…",
    refresh: "Saved · refreshing your library…",
  }[phase];
}

type SaveResult<T> =
  | { kind: "busy" | "blocked" }
  | { kind: "failed" | "unconfirmed"; error: unknown }
  | {
      kind: "confirmed";
      item: T;
      warnings: string[];
      distributionUnconfirmed: boolean;
    };

/** One write per user action. A lost write acknowledgement must be reconciled
 * with a read or explicit review, never replayed as an automatic retry. */
export function createEditorSaveController() {
  let active = false;
  let unconfirmed = false;
  return {
    get active() {
      return active;
    },
    get unconfirmed() {
      return unconfirmed;
    },
    confirmReadOnlyResult() {
      unconfirmed = false;
    },
    async run<P, T>(options: {
      action: EditorSaveAction;
      phase: (phase: EditorSavePhase) => void;
      prepare: (phase: (phase: EditorSavePhase) => void) => Promise<P>;
      write: (prepared: P) => Promise<T>;
      confirmed: (item: T, prepared: P) => void;
      distribute?: (item: T) => Promise<void>;
      refresh: () => Promise<void>;
      isUnconfirmed: (error: unknown) => boolean;
    }): Promise<SaveResult<T>> {
      if (active) return { kind: "busy" };
      if (unconfirmed) return { kind: "blocked" };
      active = true;
      try {
        let prepared: P;
        try {
          options.phase("checking");
          prepared = await options.prepare(options.phase);
        } catch (error) {
          return { kind: "failed", error };
        }
        let item: T;
        try {
          options.phase(
            options.action === "published" ? "publishing" : "saving",
          );
          item = await options.write(prepared);
        } catch (error) {
          if (options.isUnconfirmed(error)) {
            unconfirmed = true;
            return { kind: "unconfirmed", error };
          }
          return { kind: "failed", error };
        }
        // From here the server acknowledged persistence. Later errors must
        // never present it as a failed save or trigger the write a second time.
        const warnings: string[] = [];
        let distributionUnconfirmed = false;
        try {
          options.confirmed(item, prepared);
        } catch {
          warnings.push(
            "Ziipa confirmed the save, but the editor receipt could not be updated. Check your library before submitting again.",
          );
        }
        if (options.distribute) {
          options.phase("distribution");
          try {
            await options.distribute(item);
          } catch (error) {
            distributionUnconfirmed = options.isUnconfirmed(error);
            warnings.push(
              distributionUnconfirmed
                ? "Your creation is saved in Ziipa. Network delivery was not confirmed; check the outbox before requesting delivery again."
                : "Your creation is saved in Ziipa, but network delivery could not be prepared. Review destinations in the outbox.",
            );
          }
        }
        options.phase("refresh");
        try {
          await options.refresh();
        } catch {
          warnings.push(
            "Your creation is saved in Ziipa. The library refresh failed; refresh or check your library without publishing again.",
          );
        }
        return { kind: "confirmed", item, warnings, distributionUnconfirmed };
      } finally {
        active = false;
      }
    },
  };
}

function containsSubmittedValue(saved: unknown, submitted: unknown): boolean {
  if (submitted === undefined) return true;
  if (submitted === null || typeof submitted !== "object")
    return Object.is(saved, submitted);
  if (Array.isArray(submitted))
    return (
      Array.isArray(saved) &&
      saved.length === submitted.length &&
      submitted.every((value, index) =>
        containsSubmittedValue(saved[index], value),
      )
    );
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return false;
  return Object.entries(submitted).every(([key, value]) =>
    containsSubmittedValue((saved as Record<string, unknown>)[key], value),
  );
}

/** Only canonical owner-library rows can match. Titles alone are insufficient;
 * match the complete submitted edit, media identity and requested visibility. */
export function matchesEditorSubmission(
  item: Item,
  input: ItemInput,
  ownerId: number,
) {
  return (
    item.creator_id === ownerId &&
    !item.demo &&
    containsSubmittedValue(item, input)
  );
}

export function applyConfirmedEditorItem(
  current: Bootstrap,
  item: Item,
  ownerId: number,
): Bootstrap {
  if (
    item.creator_id !== ownerId ||
    item.demo ||
    !["draft", "published"].includes(item.visibility || "")
  )
    return current;
  return {
    ...current,
    drafts: [item, ...current.drafts.filter((row) => row.id !== item.id)],
    items:
      item.visibility === "published"
        ? [item, ...current.items.filter((row) => row.id !== item.id)]
        : current.items.filter((row) => row.id !== item.id),
  };
}
