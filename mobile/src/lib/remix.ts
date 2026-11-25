import type { Item } from "./types";

export const remixModes = ["stitch", "split_screen", "use_sound"] as const;
export type RemixMode = (typeof remixModes)[number];
export type RemixAudience = "disabled" | "everyone" | "followers";
export type RemixCredit = { id: string; title: string; creator: string };
export type RemixPolicy = {
  revision: number;
  audience: RemixAudience;
  modes: RemixMode[];
};
export type RemixSnapshot = {
  available: boolean;
  allowed_modes: RemixMode[];
  policy: RemixPolicy | null;
  attribution: { parent: RemixCredit | null; root: RemixCredit | null } | null;
  children: RemixCredit[];
};
export const remixStatuses = [
  "queued",
  "processing",
  "ready",
  "failed",
  "stale",
  "cancelled",
  "applied",
] as const;
export type RemixReceipt = {
  item_id: string;
  job_id: string;
  status: (typeof remixStatuses)[number];
  detail: string;
};
export type RemixCreate = {
  request_id: string;
  mode: RemixMode;
  source_start: number;
  source_seconds: number;
  response_media_id: string;
  title: string;
  rights_confirmed: true;
};
export const remixId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Ziipa returned an invalid remix response. Refresh to try again.",
    );
  return value as Record<string, unknown>;
}
function modes(value: unknown): RemixMode[] {
  if (
    !Array.isArray(value) ||
    value.length > 3 ||
    new Set(value).size !== value.length ||
    value.some((mode) => !remixModes.includes(mode))
  )
    throw new Error("Remix options could not be confirmed.");
  return value as RemixMode[];
}
function credit(value: unknown): RemixCredit | null {
  if (value === null) return null;
  const row = object(value);
  if (
    !remixId(row.id) ||
    typeof row.title !== "string" ||
    row.title.length > 140 ||
    typeof row.creator !== "string" ||
    row.creator.length > 200
  )
    throw new Error("Remix credits could not be confirmed.");
  return { id: row.id, title: row.title, creator: row.creator };
}
export function remixSnapshot(value: unknown): RemixSnapshot {
  const row = object(value);
  if (typeof row.available !== "boolean" || !Array.isArray(row.children))
    throw new Error("Remix availability could not be confirmed.");
  let policy: RemixPolicy | null = null;
  if (row.policy !== null) {
    const source = object(row.policy);
    if (
      !Number.isSafeInteger(source.revision) ||
      Number(source.revision) < 0 ||
      !["disabled", "everyone", "followers"].includes(String(source.audience))
    )
      throw new Error("Remix permissions could not be confirmed.");
    policy = {
      revision: Number(source.revision),
      audience: source.audience as RemixAudience,
      modes: modes(source.modes),
    };
  }
  const attribution = row.attribution === null ? null : object(row.attribution);
  return {
    available: row.available,
    allowed_modes: modes(row.allowed_modes),
    policy,
    attribution: attribution
      ? { parent: credit(attribution.parent), root: credit(attribution.root) }
      : null,
    children: row.children.map((entry) => {
      const item = credit(entry);
      if (!item) throw new Error("Invalid remix credit.");
      return item;
    }),
  };
}
export function remixReceipt(
  value: unknown,
  expectedItem?: string,
): RemixReceipt {
  const row = object(value);
  if (
    !remixId(row.item_id) ||
    !remixId(row.job_id) ||
    (expectedItem && row.item_id !== expectedItem) ||
    !remixStatuses.includes(row.status as RemixReceipt["status"]) ||
    typeof row.detail !== "string" ||
    row.detail.length > 4000
  )
    throw new Error(
      "Remix processing status could not be confirmed. Refresh before trying again.",
    );
  return {
    item_id: row.item_id,
    job_id: row.job_id,
    status: row.status as RemixReceipt["status"],
    detail: row.detail,
  };
}
export function remixRange(mode: RemixMode) {
  return mode === "stitch" ? { min: 1, max: 5 } : { min: 0.2, max: 30 };
}
export function validateRemixFields(
  mode: RemixMode,
  startText: string,
  secondsText: string,
  titleText: string,
  rights: boolean,
  snapshot: RemixSnapshot,
) {
  if (!snapshot.available || !snapshot.allowed_modes.includes(mode))
    throw new Error(
      "This remix option is not available right now. Refresh its permissions and status.",
    );
  if (!rights)
    throw new Error(
      "Confirm your rights to this response and source segment before continuing.",
    );
  const start = Number(startText),
    seconds = Number(secondsText),
    range = remixRange(mode);
  if (
    !startText.trim() ||
    !secondsText.trim() ||
    !Number.isFinite(start) ||
    !Number.isFinite(seconds) ||
    start < 0 ||
    start > 89.8 ||
    seconds < range.min ||
    seconds > range.max ||
    start + seconds > 90
  )
    throw new Error(
      `Choose a source start from 0 seconds and a ${range.min}–${range.max} second segment ending within 90 seconds.`,
    );
  const title = titleText.trim();
  if (!title || title.length > 140)
    throw new Error("Give your remix a title of 1–140 characters.");
  return { source_start: start, source_seconds: seconds, title };
}
export function remixCreate(
  input: Omit<
    RemixCreate,
    "rights_confirmed" | "source_start" | "source_seconds"
  > & {
    source_start: string;
    source_seconds: string;
    rights_confirmed: boolean;
  },
  snapshot: RemixSnapshot,
): RemixCreate {
  const fields = validateRemixFields(
    input.mode,
    input.source_start,
    input.source_seconds,
    input.title,
    input.rights_confirmed,
    snapshot,
  );
  if (!remixId(input.request_id) || !remixId(input.response_media_id))
    throw new Error("The response upload or request could not be confirmed.");
  return {
    request_id: input.request_id,
    mode: input.mode,
    ...fields,
    response_media_id: input.response_media_id,
    rights_confirmed: true,
  };
}
export function appliedRemix(
  value: unknown,
  receipt: RemixReceipt,
  owner: number,
  sourceId: string,
): Item {
  const row = object(value);
  if (
    row.id !== receipt.item_id ||
    row.creator_id !== owner ||
    row.visibility !== "draft" ||
    !remixId(row.media_id) ||
    row.remix_of !== sourceId ||
    typeof row.title !== "string" ||
    !row.title.trim() ||
    !Array.isArray(row.tags)
  )
    throw new Error(
      "Ziipa did not confirm your private remix draft. Refresh its status before continuing.",
    );
  return value as Item;
}
