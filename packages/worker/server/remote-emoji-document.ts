import { schemaResult } from "@tstodon/core";
import { IsoInstant, type RemoteEmoji, RemoteEmojiSchema } from "@tstodon/domain";
import { z } from "zod";

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
 * The longest image URL kept. The URL is written twice in every entity that
 * lists the emoji, so a hostile document must not set its size.
 */
const MAX_EMOJI_URL_LENGTH = 2048;

/** A document declares far fewer; this only bounds what a hostile one makes stored. */
const MAX_DECLARED = 50;

/**
 * The custom emoji a note or an actor declares in the `Emoji` objects of its
 * `tag` (a list or one object), the first of each shortcode, case and all, as
 * Mastodon keeps one `CustomEmoji` per shortcode as written. A tag whose
 * image URL is longer than `MAX_EMOJI_URL_LENGTH` is left out, and those
 * past `MAX_DECLARED`.
 */
export const declaredEmojis = (raw: unknown): ReadonlyArray<RemoteEmoji> => {
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
      seen.has(shortcode)
    ) {
      continue;
    }
    seen.add(shortcode);
    const updated = IsoInstant.parseRemote(tag.updated);
    const parsed = parseRemoteEmoji(
      updated.isOk() ? { shortcode, url, updated: updated.value } : { shortcode, url },
    );
    if (parsed.isOk()) {
      emojis.push(parsed.value);
    }
    if (emojis.length === MAX_DECLARED) {
      break;
    }
  }
  return emojis;
};
