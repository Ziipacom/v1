export type PublicGallerySettings = {
  slug: string | null;
  enabled: boolean;
  revision: number;
  public_url: string | null;
  profile_public: boolean;
  pending_render_count: number;
};

export const publicGalleryRoot = "/api/creator/gallery";
const reserved = new Set([
  "admin",
  "api",
  "auth",
  "account",
  "accounts",
  "blog",
  "create",
  "creator",
  "creators",
  "dashboard",
  "discover",
  "explore",
  "feed",
  "g",
  "gallery",
  "galleries",
  "help",
  "inbox",
  "legal",
  "login",
  "logout",
  "notifications",
  "portal",
  "privacy",
  "profile",
  "public",
  "settings",
  "share",
  "signup",
  "studio",
  "support",
  "terms",
  "wallet",
  "www",
  "ziipa",
]);
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function publicGallerySlug(value: string): string | null {
  const slug = value.trim().toLowerCase();
  if (!slug) return null;
  if (slug.length < 3 || slug.length > 40 || !slugPattern.test(slug))
    throw new Error(
      "Use 3–40 lowercase letters, numbers and single hyphens between words.",
    );
  if (reserved.has(slug))
    throw new Error("That gallery address is reserved. Choose another.");
  return slug;
}

export function loopbackGalleryBrowser(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

/** Only a canonical URL actually returned by Ziipa can leave the app. */
export function trustedPublicGalleryUrl(
  value: unknown,
  slug: string | null,
  allowLoopback = false,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !slug || publicGallerySlug(slug) !== slug)
    throw new Error("Ziipa returned an invalid public gallery URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Ziipa returned an invalid public gallery URL.");
  }
  const production = url.origin === "https://ziipa.com";
  const local =
    allowLoopback &&
    loopbackGalleryBrowser(url.hostname) &&
    ["http:", "https:"].includes(url.protocol);
  if (
    (!production && !local) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/g/${slug}` ||
    value !== `${url.origin}/g/${slug}`
  )
    throw new Error("Ziipa returned an invalid public gallery URL.");
  return url.href;
}

export function readPublicGallerySettings(
  value: unknown,
  allowLoopback = false,
): PublicGallerySettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Ziipa returned invalid gallery settings. Refresh before saving.",
    );
  const input = value as Record<string, unknown>;
  if (
    (input.slug !== null &&
      (typeof input.slug !== "string" ||
        publicGallerySlug(input.slug) !== input.slug)) ||
    typeof input.enabled !== "boolean" ||
    typeof input.profile_public !== "boolean" ||
    typeof input.pending_render_count !== "number" ||
    !Number.isSafeInteger(input.pending_render_count) ||
    input.pending_render_count < 0 ||
    typeof input.revision !== "number" ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    (input.enabled && input.slug === null) ||
    (!input.enabled && input.public_url !== null)
  )
    throw new Error(
      "Ziipa returned invalid gallery settings. Refresh before saving.",
    );
  return {
    slug: input.slug as string | null,
    enabled: input.enabled,
    revision: input.revision,
    profile_public: input.profile_public,
    pending_render_count: input.pending_render_count,
    public_url: trustedPublicGalleryUrl(
      input.public_url,
      input.slug as string | null,
      allowLoopback,
    ),
  };
}

export type PublicGalleryForm = {
  saved: PublicGallerySettings | null;
  slug: string;
  enabled: boolean;
  needsReview: boolean;
};
export const emptyPublicGalleryForm = (): PublicGalleryForm => ({
  saved: null,
  slug: "",
  enabled: false,
  needsReview: false,
});

export function publicGalleryDirty(form: PublicGalleryForm): boolean {
  return (
    form.slug.trim().toLowerCase() !== (form.saved?.slug || "") ||
    form.enabled !== (form.saved?.enabled || false)
  );
}

/** Refresh updates server truth but never discards an owner's unsaved address. */
export function mergePublicGalleryRefresh(
  form: PublicGalleryForm,
  saved: PublicGallerySettings,
  manuallyReviewed = false,
): PublicGalleryForm {
  const dirty = publicGalleryDirty(form);
  const changed = form.saved !== null && form.saved.revision !== saved.revision;
  return {
    saved,
    slug: dirty ? form.slug : saved.slug || "",
    enabled: dirty ? form.enabled : saved.enabled,
    needsReview: manuallyReviewed
      ? false
      : form.needsReview || (dirty && changed),
  };
}

export function publicGalleryInput(form: PublicGalleryForm) {
  if (!form.saved || form.needsReview)
    throw new Error(
      "Refresh and review the latest gallery settings before saving.",
    );
  const slug = publicGallerySlug(form.slug);
  if (!slug)
    throw new Error(
      "Enter a gallery address. To stop sharing, turn off the public gallery; reserved names stay with your account.",
    );
  if (form.enabled && !form.saved.profile_public)
    throw new Error(
      "Save public profile visibility in Privacy controls before enabling a public gallery.",
    );
  return { slug, enabled: form.enabled, revision: form.saved.revision };
}

/** Revocation does not depend on an unfinished rename or use its mutation route. */
export function publicGalleryRequest(form: PublicGalleryForm) {
  if (form.saved?.enabled && !form.enabled) {
    const input = publicGalleryInput({
      ...form,
      slug: form.saved.slug || "",
      enabled: false,
    });
    return {
      path: `${publicGalleryRoot}/disable`,
      body: { revision: input.revision },
      slug: input.slug,
      enabled: false,
      revision: input.revision,
      revoking: true,
    };
  }
  const input = publicGalleryInput(form);
  return { path: publicGalleryRoot, body: input, ...input, revoking: false };
}

export function publicGalleryFailure(error: unknown, write = false) {
  const value = error as {
    status?: unknown;
    message?: unknown;
    outcome?: unknown;
  } | null;
  if (value?.status === 404)
    return {
      kind: "deployment",
      message:
        "Public gallery links require the updated Ziipa server and website. This deployment is not ready yet.",
    } as const;
  if (value?.status === 409) {
    if (
      value.message ===
      "That gallery address is already reserved. Choose another."
    )
      return {
        kind: "taken",
        message: "That gallery address is already reserved. Choose another.",
      } as const;
    if (
      value.message ===
      "Public gallery links require a public profile. Change profile privacy deliberately first."
    )
      return {
        kind: "privacy",
        message:
          "Your profile is not public. Save public visibility in Privacy controls, then refresh gallery status.",
      } as const;
    return {
      kind: "conflict",
      message:
        "Gallery settings changed elsewhere. Your unsaved address is kept. Refresh, review the latest saved settings, then save deliberately.",
    } as const;
  }
  if (value?.status === 422)
    return {
      kind: "validation",
      message:
        "Check the gallery address: 3–40 lowercase letters, numbers and single hyphens; reserved names cannot be used.",
    } as const;
  if (
    write &&
    (value?.outcome === "unconfirmed" ||
      typeof value?.status !== "number" ||
      value.status >= 500)
  )
    return {
      kind: "unconfirmed",
      message:
        "Ziipa did not confirm this change. It may have saved. Your edits are kept; refresh the saved status before trying again.",
    } as const;
  return {
    kind: "unavailable",
    message:
      "Gallery settings could not load. Check your connection and refresh; your unsaved address is kept.",
  } as const;
}
