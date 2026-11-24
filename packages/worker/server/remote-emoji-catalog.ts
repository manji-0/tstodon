import type { ApiCustomEmojiJSON } from "@tstodon/api";
import { z } from "zod";
import { parseRows, runD1 } from "./d1";
import { scannedShortcodes } from "./emoji";
import { findRemoteCustomEmojis } from "./generated/prisma/sql";
import { httpUrl } from "./sanitize-html";
import { queryTyped } from "./typed-sql";

/**
 * The custom emoji a page of remote posts and profiles shows, read when the
 * page is rendered, as Mastodon v4.7.5 renders `CustomEmoji.from_text(text,
 * account.domain)` (`Status#emojis`, `StatusEdit#emojis`, `Poll#emojis`,
 * `Account#emojis`): each `:shortcode:` a text writes shows the enabled emoji
 * `remote_custom_emojis` holds under it for the author's account domain, its
 * current image, whether or not the document declared it and whenever it was
 * learned. A page reads them all in one statement, a primary-key seek per
 * domain and shortcode.
 */
export type RemoteEmojiCatalog = ReadonlyMap<
  /** The account domain. */
  string,
  /** The image of each enabled emoji read, by shortcode as written. */
  ReadonlyMap<string, string>
>;

const NO_REMOTE_EMOJIS: RemoteEmojiCatalog = new Map();

/** What one document writes: the texts `from_text` scans, by an author of `domain`. */
export type RemoteEmojiWriting = Readonly<{ domain: string; texts: ReadonlyArray<string> }>;

/**
 * A document writes far fewer; this bounds what a hostile one makes a page
 * read. A shortcode past it does not show.
 */
const MAX_DOCUMENT_SHORTCODES = 50;

const shortcodesOf = (texts: ReadonlyArray<string>): ReadonlyArray<string> =>
  scannedShortcodes(texts).slice(0, MAX_DOCUMENT_SHORTCODES);

const Row = z.object({ domain: z.string(), shortcode: z.string(), image_url: z.string() });

/**
 * The enabled emoji `writings` write, read in one statement. A failed read
 * shows no emoji: the posts and profiles still render, as they do when the
 * read of their cards fails.
 */
export const loadRemoteEmojis = async (
  db: D1Database,
  writings: ReadonlyArray<RemoteEmojiWriting>,
): Promise<RemoteEmojiCatalog> => {
  const pairs = new Map<string, readonly [string, string]>();
  for (const { domain, texts } of writings) {
    for (const shortcode of shortcodesOf(texts)) {
      pairs.set(JSON.stringify([domain, shortcode]), [domain, shortcode]);
    }
  }
  if (pairs.size === 0) {
    return NO_REMOTE_EMOJIS;
  }
  const rows = await runD1(() =>
    queryTyped(db, findRemoteCustomEmojis(JSON.stringify([...pairs.values()])), Row),
  );
  if (rows.isErr()) {
    console.error(JSON.stringify({ kind: "RemoteEmojisNotRead", error: rows.error.message }));
    return NO_REMOTE_EMOJIS;
  }
  const images = new Map<string, Map<string, string>>();
  for (const row of rows.value) {
    const byShortcode = images.get(row.domain) ?? new Map<string, string>();
    byShortcode.set(row.shortcode, row.image_url);
    images.set(row.domain, byShortcode);
  }
  return images;
};

/** The CustomEmoji entities texts by one author show, in the order they are first written. */
export type EmojisOf = (texts: ReadonlyArray<string>) => ApiCustomEmojiJSON[];

/**
 * The emoji texts by an author of `domain` show, as `from_text` lists them.
 * An image that is not an http(s) URL is left out.
 */
export const emojisOf =
  (catalog: RemoteEmojiCatalog, domain: string): EmojisOf =>
  (texts) => {
    const images = catalog.get(domain);
    if (images === undefined) {
      return [];
    }
    return shortcodesOf(texts).flatMap((shortcode) => {
      const url = images.get(shortcode);
      return url === undefined || httpUrl(url) === undefined
        ? []
        : [{ shortcode, url, static_url: url, visible_in_picker: false }];
    });
  };

const DomainRow = z.object({ domain: z.string() });

/**
 * The emoji the documents of the remote actor `actorUri` show, each written
 * as one of `documents` (its texts), for a response that renders only its
 * documents: its account domain is read first. An author not cached shows
 * none.
 */
export const loadAuthorEmojis = async (
  db: D1Database,
  actorUri: string,
  documents: ReadonlyArray<ReadonlyArray<string>>,
): Promise<EmojisOf> => {
  const author = await runD1(async () =>
    parseRows(
      DomainRow,
      (
        await db
          .prepare("SELECT domain FROM remote_actors WHERE actor_uri = ?")
          .bind(actorUri)
          .all()
      ).results,
    ),
  );
  const domain = author.isOk() ? author.value[0]?.domain : undefined;
  return domain === undefined
    ? () => []
    : emojisOf(
        await loadRemoteEmojis(
          db,
          documents.map((texts) => ({ domain, texts })),
        ),
        domain,
      );
};
