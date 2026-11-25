/** Confirmed 1.0.20 source: release commit 6e8f30e, including 17d4dbc.
 * Add entries only when the corresponding release is prepared for distribution.
 * Pending local UI changes must not be added to an earlier version's notes.
 */
export const releaseNotes = [
  {
    version: "1.0.20",
    changes: [
      "Show or hide your password while signing in.",
      "Crop and resize a photo before saving your profile avatar.",
      "Open your creations library directly from Profile → Edit.",
      "Improved video-feed comments and creator profile images.",
    ],
  },
] as const;
