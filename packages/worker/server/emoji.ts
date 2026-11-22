import type { ApiCustomEmojiJSON } from "@tstodon/api";

/**
 * Where a custom emoji of this instance comes from. One an admin uploaded
 * (`custom_emojis`) has its own ActivityPub document (`/emojis/:id`), dated
 * by its last change, as Mastodon's `CustomEmoji`; one the `CUSTOM_EMOJIS`
 * var configures has none.
 */
export type CustomEmojiSource =
  | Readonly<{ kind: "Uploaded"; id: string; updatedAt: string; contentType: string }>
  | Readonly<{ kind: "Configured" }>;

export type UploadedEmojiSource = Extract<CustomEmojiSource, { kind: "Uploaded" }>;

/** A custom emoji of this instance. */
export type CustomEmoji = Readonly<{
  shortcode: string;
  url: string;
  static_url: string;
  visible_in_picker: boolean;
  category?: string;
  source: CustomEmojiSource;
}>;

/** An emoji an admin uploaded. */
export type UploadedCustomEmoji = CustomEmoji & Readonly<{ source: UploadedEmojiSource }>;

export const customEmojiJson = (emoji: CustomEmoji): ApiCustomEmojiJSON => ({
  shortcode: emoji.shortcode,
  url: emoji.url,
  static_url: emoji.static_url,
  visible_in_picker: emoji.visible_in_picker,
  ...(emoji.category === undefined ? {} : { category: emoji.category }),
});

/**
 * Mastodon's `CustomEmoji::SCAN_RE`: two or more of `[a-zA-Z0-9_]` between
 * colons, with no letter, mark, digit or colon on either side (Onigmo's
 * `[[:alnum:]]` is Letter, Mark and Decimal_Number).
 */
const SCAN_RE = /(?<=^|[^\p{L}\p{M}\p{Nd}:]):([a-zA-Z0-9_]{2,}):(?=[^\p{L}\p{M}\p{Nd}:]|$)/gu;

/**
 * The shortcodes `texts` write, once each in first-use order, as
 * `CustomEmoji.from_text` scans them.
 */
export const scannedShortcodes = (texts: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(
    texts.flatMap((text) =>
      [...text.matchAll(SCAN_RE)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])),
    ),
  ),
];

/** The texts Mastodon's `Status#emojis` scans: the spoiler, the text and the poll's options. */
export const statusEmojiTexts = (
  status: Readonly<{ spoilerText: string; text: string }>,
  pollOptions: ReadonlyArray<string> = [],
): ReadonlyArray<string> => [status.spoilerText, status.text, ...pollOptions];

/**
 * The texts Mastodon's `Account#emojis` scans (`emojifiable_text`): the note,
 * the display name, and each field's name and value.
 */
export const profileEmojiTexts = (
  displayName: string,
  profile: Readonly<{
    note: string;
    fields: ReadonlyArray<Readonly<{ name: string; value: string }>>;
  }>,
): ReadonlyArray<string> => [
  profile.note,
  displayName,
  ...profile.fields.map((field) => field.name),
  ...profile.fields.map((field) => field.value),
];

/**
 * Configured emojis whose `:shortcode:` one of `texts` writes, in first-use
 * order. A shortcode matches as written, case and all, as Mastodon's
 * `CustomEmoji.from_text`: a remote server matches an `Emoji` tag's name
 * against the text the same way, so `:Blob:` is not the emoji `blob`.
 */
export const emojisInTexts = (
  texts: ReadonlyArray<string>,
  emojis: ReadonlyArray<CustomEmoji>,
): ReadonlyArray<CustomEmoji> => {
  if (emojis.length === 0) {
    return [];
  }
  const byShortcode = new Map(emojis.map((emoji) => [emoji.shortcode, emoji]));
  return scannedShortcodes(texts).flatMap((shortcode) => {
    const emoji = byShortcode.get(shortcode);
    return emoji === undefined ? [] : [emoji];
  });
};
