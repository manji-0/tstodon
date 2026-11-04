import type { RemoteEmoji } from "@tstodon/domain";
import { httpUrl } from "./sanitize-html";

/** The emoji whose `:shortcode:` appears in one of `texts`. */
export const remoteEmojisInTexts = (
  texts: ReadonlyArray<string>,
  emojis: ReadonlyArray<RemoteEmoji>,
): ReadonlyArray<RemoteEmoji> => {
  const used = new Set(
    texts.flatMap((text) =>
      [...text.matchAll(/:([a-zA-Z0-9_]+):/g)].flatMap((match) =>
        match[1] ? [match[1].toLowerCase()] : [],
      ),
    ),
  );
  return emojis.filter((emoji) => used.has(emoji.shortcode.toLowerCase()));
};

/** CustomEmoji entities of a remote note's emoji; one whose image is not an http(s) URL is left out. */
export const remoteEmojisJson = (
  emojis: ReadonlyArray<RemoteEmoji>,
): ReadonlyArray<Record<string, unknown>> =>
  emojis.flatMap((emoji) =>
    httpUrl(emoji.url) === undefined
      ? []
      : [
          {
            shortcode: emoji.shortcode,
            url: emoji.url,
            static_url: emoji.url,
            visible_in_picker: false,
          },
        ],
  );
