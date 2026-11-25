export const creationTitleLimit = 140;

/** Old uploader defaults must be reviewed when their creation is edited again. */
export function initialCreationTitle(value?: string): string {
  if (!value) return "";
  const stem = value
    .trim()
    .replace(/\.(?:jpe?g|png|heic|heif|webp|gif|mov|mp4|m4v)$/i, "");
  if (
    /^(?:img|vid|dsc|dscn|pxl|image|video)[_-]?\d[\w-]*$/i.test(stem) ||
    /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(stem)
  )
    return "";
  return value;
}

export function requiredCreationTitle(value: string): string {
  const title = value.trim();
  if (!title)
    throw new Error(
      "A creation title is required. Enter a title or use a suggestion from your media.",
    );
  if (title.length > creationTitleLimit)
    throw new Error("Keep your creation title to 140 characters.");
  return title;
}

/** Suggestions enter the editing form only; Save/Publish remain explicit. */
export function suggestedCreationTitle(value: unknown): string {
  if (!value || typeof value !== "object")
    throw new Error(
      "No title suggestion was returned. You can enter your own title.",
    );
  const title = (value as { title?: unknown }).title;
  if (typeof title !== "string" || /[\u0000-\u001f\u007f<>]|:\/\//.test(title))
    throw new Error(
      "No usable title was returned. You can enter your own title.",
    );
  return requiredCreationTitle(title);
}

export type CreationCopy = { title: string; description: string };
export function suggestedCreationCopy(value: unknown): CreationCopy {
  const title = suggestedCreationTitle(value);
  const description = (value as { description?: unknown }).description;
  if (
    typeof description !== "string" ||
    !description.trim() ||
    description.length > 600 ||
    /[\u0000-\u001f\u007f<>]|:\/\//.test(description)
  )
    throw new Error(
      "AI could not describe this media. You can enter your own title and description.",
    );
  return { title, description: description.trim() };
}

/** Track authorship separately from text equality, including deliberate clears. */
export function createCreationCopyController() {
  const touched = { title: false, description: false };
  let generated: Partial<CreationCopy> = {};
  let generatedSource = "";
  const canFill = (field: keyof CreationCopy, value: string) =>
    !touched[field] && (!value.trim() || value === generated[field]);
  return {
    edit(field: keyof CreationCopy) {
      touched[field] = true;
    },
    needs(source: string, current: CreationCopy) {
      return (
        source !== generatedSource &&
        (canFill("title", current.title) ||
          canFill("description", current.description))
      );
    },
    apply(
      source: string,
      current: CreationCopy,
      suggestion: CreationCopy,
    ): CreationCopy {
      const next = { ...current };
      for (const field of ["title", "description"] as const) {
        if (canFill(field, current[field])) {
          next[field] = suggestion[field];
          generated[field] = suggestion[field];
        }
      }
      generatedSource = source;
      return next;
    },
  };
}
