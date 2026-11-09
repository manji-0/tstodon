/**
 * Instance limits advertised by `/api/v2/instance` and enforced by the worker
 * and domain. Keep these in one place so the advertised numbers are true:
 * every value here is both rendered by the instance document and checked
 * where the request it limits is handled.
 */
export const InstanceLimits = {
  status: {
    /**
     * Unicode code points in the content warning and the post body together,
     * as {@link countableText} counts them (Mastodon's `StatusLengthValidator`).
     */
    maxCharacters: 500,
    maxMediaAttachments: 4,
    /** What a URL counts for, whatever its length. */
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
    /** At most this many profile fields (Mastodon's `DEFAULT_FIELDS_SIZE`). */
    maxProfileFields: 4,
    /** Code points in the display name. */
    maxDisplayNameCharacters: 30,
    /** The bio, counted as {@link countableText} counts it (`NoteLengthValidator`). */
    maxNoteCharacters: 500,
    /**
     * Mastodon 4.6's avatar and header alt text. tstodon does not store
     * either description yet (it ignores them), so nothing longer is kept.
     */
    maxAvatarDescriptionCharacters: 150,
    maxHeaderDescriptionCharacters: 150,
    maxProfileFieldNameCharacters: 255,
    maxProfileFieldValueCharacters: 255,
  },
  media: {
    maxDescriptionCharacters: 1500,
    /**
     * Mastodon's default upload limits. Sizes are bytes of the uploaded
     * file; the matrix limits are width x height, read from the image's or
     * video's header (no decoding); the frame rate is the video track's
     * average, from its container (an MP4 track's sample count over its
     * duration, a WebM track's `DefaultDuration`), and is not checked when
     * the container does not say.
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

/**
 * A bare `http(s)` URL in post text, as Mastodon's web UI and
 * `StatusLengthValidator` count it: whatever follows the scheme up to
 * whitespace, without trailing punctuation. Not inside a word or after `/`
 * or `@`.
 */
const COUNTED_URL = /(^|[^\p{L}\p{N}_/@])(https?:\/\/[^\s<>"']*[^\s<>"'.,:;!?)\]}*])/giu;

/** `@user@domain`, which counts as `@user` (the domain is free, as in Mastodon). */
const COUNTED_REMOTE_MENTION = /(^|[^/\w])@([a-z0-9_]+)@[a-z0-9.-]+[a-z0-9]+/gi;

/**
 * The text Mastodon counts against a length limit: each URL is
 * `charactersReservedPerUrl` characters long, and a remote mention counts
 * without its domain (Mastodon's `countable_text`, and the web UI's
 * `countableText`).
 */
export const countableText = (text: string): string =>
  text
    .replace(
      COUNTED_URL,
      (_match, before: string) =>
        `${before}${"x".repeat(InstanceLimits.status.charactersReservedPerUrl)}`,
    )
    .replace(COUNTED_REMOTE_MENTION, "$1@$2");

/** {@link characterCount} of {@link countableText}. */
export const countableLength = (text: string): number => characterCount(countableText(text));
