import type { ApiCustomEmojiJSON } from "@tstodon/api";

/** A custom emoji configured on this instance (`CUSTOM_EMOJIS`). */
export type CustomEmoji = Readonly<{
  shortcode: string;
  url: string;
  static_url: string;
  visible_in_picker: boolean;
  category?: string;
}>;

export const customEmojiJson = (emoji: CustomEmoji): ApiCustomEmojiJSON => ({
  shortcode: emoji.shortcode,
  url: emoji.url,
  static_url: emoji.static_url,
  visible_in_picker: emoji.visible_in_picker,
  ...(emoji.category === undefined ? {} : { category: emoji.category }),
});

/**
 * Configured emojis whose `:shortcode:` appears in `text`, in first-use order.
 * A shortcode matches as written, case and all, as Mastodon's
 * `CustomEmoji.from_text`: a remote server matches an `Emoji` tag's name
 * against the text the same way, so `:Blob:` is not the emoji `blob`.
 */
export const emojisInText = (
  text: string,
  emojis: ReadonlyArray<CustomEmoji>,
): ReadonlyArray<CustomEmoji> => {
  if (emojis.length === 0 || text.length === 0) {
    return [];
  }
  const byShortcode = new Map(emojis.map((emoji) => [emoji.shortcode, emoji]));
  const found: CustomEmoji[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/:([a-zA-Z0-9_]+):/g)) {
    const shortcode = match[1];
    if (shortcode === undefined || seen.has(shortcode)) {
      continue;
    }
    const emoji = byShortcode.get(shortcode);
    if (emoji) {
      seen.add(shortcode);
      found.push(emoji);
    }
  }
  return found;
};

/** Emojis used across the given texts, de-duplicated by shortcode. */
export const emojisInTexts = (
  texts: ReadonlyArray<string>,
  emojis: ReadonlyArray<CustomEmoji>,
): ReadonlyArray<CustomEmoji> => {
  const found: CustomEmoji[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const emoji of emojisInText(text, emojis)) {
      if (!seen.has(emoji.shortcode)) {
        seen.add(emoji.shortcode);
        found.push(emoji);
      }
    }
  }
  return found;
};
