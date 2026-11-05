import { jsonStringArray } from "./d1";
import { insertTagNames as insertTagNamesSql } from "./generated/prisma/sql";
import { d1PrepareTyped } from "./typed-sql";

/**
 * The hashtags in a local note's text, lowercase and without the `#`. The
 * `0107_tags.sql` backfill reads stored notes the same way.
 */
export const extractHashtags = (text: string): string[] => {
  return [
    ...new Set(
      [...text.matchAll(/#([A-Za-z0-9_]+)/g)].flatMap(([, tag]) =>
        tag ? [tag.toLowerCase()] : [],
      ),
    ),
  ];
};

/** How many times each hashtag occurs across these texts, in first-seen order. */
export const hashtagUses = (texts: ReadonlyArray<string>): Map<string, number> =>
  texts
    .flatMap(extractHashtags)
    .reduce((uses, tag) => uses.set(tag, (uses.get(tag) ?? 0) + 1), new Map<string, number>());

/**
 * One statement that stores these tag names in `tags`, the names hashtag
 * search finds, for a batch that writes what uses or follows them.
 */
export const recordTagNames = (db: D1Database, names: ReadonlyArray<string>): D1PreparedStatement =>
  d1PrepareTyped(db, insertTagNamesSql(jsonStringArray(names)));
