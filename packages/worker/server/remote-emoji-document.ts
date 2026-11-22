import type { ApiCustomEmojiJSON } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import { IsoInstant, type RemoteEmoji, RemoteEmojiSchema } from "@tstodon/domain";
import { z } from "zod";
import { httpUrl } from "./sanitize-html";

const parseRemoteEmoji = schemaResult(RemoteEmojiSchema);

const parseTagged = schemaResult(z.object({ tag: z.unknown().optional() }));

const parseEmojiTag = schemaResult(
  z
    .object({
      type: z.string().optional(),
      name: z.string().optional(),
      updated: z.unknown().optional(),
      icon: z.object({ url: z.string().optional() }).passthrough().optional(),
    })
    .passthrough(),
);

/**
 * The entries of a document's `tag` that read as objects. `tag` is a list or
 * one object, as Mastodon's `as_array` takes it.
 */
const tagEntries = (raw: unknown) => {
  const tagged = parseTagged(raw);
  const tag = tagged.isOk() ? tagged.value.tag : undefined;
  const entries: ReadonlyArray<unknown> = Array.isArray(tag) ? tag : [tag];
  return entries.flatMap((entry) => {
    const parsed = parseEmojiTag(entry);
    return parsed.isOk() ? [parsed.value] : [];
  });
};

/**
 * The longest image URL kept. The URL is stored with the note or the profile
 * and written twice in every entity that lists the emoji, so a hostile
 * document must not set its size.
 */
const MAX_EMOJI_URL_LENGTH = 2048;

/**
 * The custom emoji a note or an actor declares in the `Emoji` objects of its
 * `tag` (a list or one object), the first of each shortcode. `sameAs` gives the form in which two
 * shortcodes are one. A tag whose image URL is longer than
 * `MAX_EMOJI_URL_LENGTH` is left out.
 */
export const declaredEmojis = (
  raw: unknown,
  sameAs: (shortcode: string) => string,
): ReadonlyArray<RemoteEmoji> => {
  const seen = new Set<string>();
  const emojis: RemoteEmoji[] = [];
  for (const tag of tagEntries(raw)) {
    const shortcode = tag.name?.replace(/^:|:$/g, "");
    const url = tag.icon?.url;
    if (
      tag.type !== "Emoji" ||
      !shortcode ||
      !url ||
      url.length > MAX_EMOJI_URL_LENGTH ||
      seen.has(sameAs(shortcode))
    ) {
      continue;
    }
    seen.add(sameAs(shortcode));
    const updated = IsoInstant.parseRemote(tag.updated);
    const parsed = parseRemoteEmoji(
      updated.isOk() ? { shortcode, url, updated: updated.value } : { shortcode, url },
    );
    if (parsed.isOk()) {
      emojis.push(parsed.value);
    }
  }
  return emojis;
};

/** The shortcodes `texts` write between colons. */
const shortcodesIn = (texts: ReadonlyArray<string>): ReadonlyArray<string> =>
  texts.flatMap((text) =>
    [...text.matchAll(/:([a-zA-Z0-9_]+):/g)].flatMap((match) => (match[1] ? [match[1]] : [])),
  );

/** The emoji whose `:shortcode:` appears in one of `texts`. */
export const remoteEmojisInTexts = (
  texts: ReadonlyArray<string>,
  emojis: ReadonlyArray<RemoteEmoji>,
): ReadonlyArray<RemoteEmoji> => {
  const used = new Set(shortcodesIn(texts).map((shortcode) => shortcode.toLowerCase()));
  return emojis.filter((emoji) => used.has(emoji.shortcode.toLowerCase()));
};

/** A profile writes far fewer; this only bounds a hostile document. */
const MAX_ACTOR_EMOJIS = 50;

/**
 * The custom emoji an actor declares and `texts` (its display name, note and
 * fields) write. A shortcode matches as written, case and all, as Mastodon's
 * `CustomEmoji.from_text` finds an account's emoji.
 */
export const actorEmojis = (
  raw: unknown,
  texts: ReadonlyArray<string>,
): ReadonlyArray<RemoteEmoji> => {
  const written = new Set(shortcodesIn(texts));
  return declaredEmojis(raw, (shortcode) => shortcode)
    .filter((emoji) => written.has(emoji.shortcode))
    .slice(0, MAX_ACTOR_EMOJIS);
};

/** CustomEmoji entities of a remote note's emoji; one whose image is not an http(s) URL is left out. */
export const remoteEmojisJson = (emojis: ReadonlyArray<RemoteEmoji>): ApiCustomEmojiJSON[] =>
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
