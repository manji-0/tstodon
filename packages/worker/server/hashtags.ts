import { extractHashtags } from "@tstodon/core";
import { Visibility } from "@tstodon/domain";
import { jsonStringArray } from "./d1";
import { decodeHtmlEntities } from "./html";
import {
  insertLocalStatusTags as insertLocalStatusTagsSql,
  insertTagNames as insertTagNamesSql,
} from "./generated/prisma/sql";
import { d1PrepareTyped } from "./typed-sql";

/**
 * The hashtags in a remote note's HTML, read from its text as
 * {@link extractHashtags} reads a local note's. A link counts only when its
 * text is a hashtag (Mastodon renders one as `#<span>name</span>`): another
 * link's text is a URL or a mention, whose fragment or path is no tag even
 * where the link splits it across spans. Only the backfill reads tags this
 * way, for a status stored without them: a note that arrives is indexed
 * under its `Hashtag` tag objects (`noteHashtags`).
 */
export const htmlHashtags = (html: string): string[] =>
  extractHashtags(
    decodeHtmlEntities(
      html
        .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (_, inner: string) => {
          const text = inner.replace(/<[^>]*>/g, "");
          return /^[#＃]/u.test(text) ? ` ${text} ` : " ";
        })
        .replace(/<[^>]*>/g, " "),
    ),
  );

/** How many times each hashtag occurs across these texts, in first-seen order. */
export const hashtagUses = (texts: ReadonlyArray<string>): Map<string, number> =>
  texts
    .flatMap(extractHashtags)
    .reduce((uses, tag) => uses.set(tag, (uses.get(tag) ?? 0) + 1), new Map<string, number>());

/**
 * The tag names a note with this visibility lets hashtag search find: those
 * of a public or unlisted note, whose text anyone can read already. A direct
 * or followers-only note's names stay out, since search shows them to anyone.
 */
export const searchableTagNames = (
  visibility: Visibility,
  names: ReadonlyArray<string>,
): ReadonlyArray<string> => (Visibility.isRestricted(visibility) ? [] : names);

/**
 * The statement that stores these tag names in `tags`, the names hashtag
 * search finds, for a batch that writes what uses or follows them; none when
 * there are no names.
 */
export const recordTagNames = (
  db: D1Database,
  names: ReadonlyArray<string>,
): ReadonlyArray<D1PreparedStatement> =>
  names.length === 0 ? [] : [d1PrepareTyped(db, insertTagNamesSql(jsonStringArray(names)))];

/**
 * The statement that indexes the account's local note under its tags
 * (`local_status_tags`, what the tag timelines, the `tagged` filter and the
 * hashtag streams match), for the batch that writes the note; none when it
 * has no tag. A note of any visibility is indexed: the readers check that.
 */
export const indexLocalStatusTags = (
  db: D1Database,
  note: Readonly<{ id: string; accountId: string }>,
  tags: ReadonlyArray<string>,
): ReadonlyArray<D1PreparedStatement> =>
  tags.length === 0
    ? []
    : [
        d1PrepareTyped(
          db,
          insertLocalStatusTagsSql(note.id, note.accountId, jsonStringArray(tags)),
        ),
      ];
