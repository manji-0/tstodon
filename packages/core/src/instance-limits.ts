/**
 * Instance limits advertised by `/api/v2/instance` and enforced by the worker
 * and domain. Keep these in one place so the advertised numbers are true.
 */
export const InstanceLimits = {
  status: {
    /** Unicode code points in the post body (Mastodon counts characters). */
    maxCharacters: 500,
    maxSpoilerCharacters: 500,
    maxMediaAttachments: 4,
    charactersReservedPerUrl: 23,
  },
  poll: {
    minOptions: 2,
    maxOptions: 4,
    maxOptionCharacters: 50,
    minExpirationSeconds: 300,
    maxExpirationSeconds: 2_629_746,
  },
  account: {
    maxPinnedStatuses: 5,
    maxFeaturedTags: 10,
    /** Mastodon keeps at most this many profile fields (`Account::Field::LIMIT`). */
    maxProfileFields: 4,
    /**
     * Mastodon's defaults, advertised so clients size their profile forms;
     * the Worker does not refuse longer values yet.
     */
    maxDisplayNameCharacters: 30,
    maxNoteCharacters: 500,
    maxAvatarDescriptionCharacters: 150,
    maxHeaderDescriptionCharacters: 150,
    maxProfileFieldNameCharacters: 255,
    maxProfileFieldValueCharacters: 255,
  },
  media: {
    maxDescriptionCharacters: 1500,
    /**
     * Mastodon's default upload limits, advertised so clients check before
     * uploading; the Worker does not refuse larger uploads by them yet.
     */
    imageMatrixLimit: 33_177_600,
    imageSizeLimit: 16_777_216,
    videoFrameRateLimit: 120,
    videoMatrixLimit: 8_294_400,
    videoSizeLimit: 103_809_024,
    /** What an upload may declare; advertised by /api/v2/instance. */
    supportedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/avif",
      "video/mp4",
      "video/webm",
    ],
  },
} as const;

/**
 * Number of Unicode code points, which is what Mastodon counts for limits
 * (Ruby's `String#length`). Grapheme clusters are intentionally not merged.
 */
export const characterCount = (text: string): number => Array.from(text).length;
