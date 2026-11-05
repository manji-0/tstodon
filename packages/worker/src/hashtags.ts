import { Visibility } from "@tstodon/domain";
import { jsonStringArray } from "./d1";
import { decodeHtmlEntities } from "./html";
import { insertTagNames as insertTagNamesSql } from "./generated/prisma/sql";
import { d1PrepareTyped } from "./typed-sql";

/**
 * A `#` and the tag name after it. As Mastodon's `HASHTAG_RE`, a `#` right
 * after a letter, a digit, `=`, `/` or `)` starts no tag, so a URL fragment
 * (`/invite#Kq8sZ2pX`) or `word#token` is not one, and a name needs a letter
 * (`#2024` is none). A `#` after `&` starts none either, so an undecoded
 * numeric entity (`&#8217;`, `&#x27;`) in a remote note is no tag.
 */
const HASHTAG = /(?<![=/)&\p{Alphabetic}\p{Nd}])#([A-Za-z0-9_]*[A-Za-z][A-Za-z0-9_]*)/gu;

/** The unique hashtags in a local note's text, lowercase and without the `#`. */
export const extractHashtags = (text: string): string[] => [
  ...new Set([...text.matchAll(HASHTAG)].flatMap(([, tag]) => (tag ? [tag.toLowerCase()] : []))),
];

/**
 * The hashtags in a remote note's HTML, read from its text as
 * {@link extractHashtags} reads a local note's. A link counts only when its
 * text is a hashtag (Mastodon renders one as `#<span>name</span>`): another
 * link's text is a URL or a mention, whose fragment or path is no tag even
 * where the link splits it across spans.
 */
export const htmlHashtags = (html: string): string[] =>
  extractHashtags(
    decodeHtmlEntities(
      html
        .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (_, inner: string) => {
          const text = inner.replace(/<[^>]*>/g, "");
          return text.startsWith("#") ? ` ${text} ` : " ";
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
