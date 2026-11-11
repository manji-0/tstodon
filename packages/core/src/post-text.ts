import { InstanceLimits } from "./instance-limits";
import { POST_URL_PATTERN } from "./post-text-url-pattern";

/**
 * How Mastodon counts post text against a length limit, shared by the Worker
 * (which enforces the limits) and the web UI (which shows what is left). It
 * imports no Zod, so the web UI can load it: `@tstodon/core/post-text`.
 */

/**
 * An `http(s)` URL in post text: twitter-text's pattern with the scheme
 * required, as Mastodon's web UI and `StatusLengthValidator` find URLs. `$2`
 * is the character before the URL. Global: use it with `replace`, which
 * resets `lastIndex`.
 */
export const postUrlRegex = new RegExp(POST_URL_PATTERN.source, POST_URL_PATTERN.flags);

/** `@user@domain`, which counts as `@user` (the domain is free). */
const REMOTE_MENTION = /(^|[^/\w])@(([a-z0-9_]+)@[a-z0-9.-]+[a-z0-9]+)/gi;

const URL_PLACEHOLDER = "x".repeat(InstanceLimits.status.charactersReservedPerUrl);

/**
 * The text Mastodon counts: each URL is `charactersReservedPerUrl`
 * characters long, and a remote mention counts without its domain
 * (`StatusLengthValidator#countable_text`).
 */
export const countableText = (text: string): string =>
  text.replace(postUrlRegex, `$2${URL_PLACEHOLDER}`).replace(REMOTE_MENTION, "$1@$3");

const graphemes =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * Grapheme clusters, as Ruby's `each_grapheme_cluster`: `👍🏽` is one. A
 * browser without `Intl.Segmenter` counts code points, which is never less.
 */
export const graphemeLength = (text: string): number => {
  if (graphemes === null) {
    return Array.from(text).length;
  }
  let count = 0;
  for (const _ of graphemes.segment(text)) {
    count += 1;
  }
  return count;
};

/**
 * A status's length against `InstanceLimits.status.maxCharacters`: the
 * content warning as written, then the countable text
 * (`StatusLengthValidator#too_long?`).
 */
export const statusLength = (spoilerText: string, text: string): number =>
  graphemeLength(spoilerText + countableText(text));

/** A profile note's length against `InstanceLimits.account.maxNoteCharacters`. */
export const noteLength = (note: string): number => graphemeLength(countableText(note));

/**
 * Mastodon's `Tag` hashtag classes, from Ruby's POSIX brackets on Unicode
 * strings: `[[:word:]]`, `[[:alpha:]]`, `[[:space:]]` and `[[:alnum:]]`.
 */
const WORD = "\\p{L}\\p{M}\\p{Nd}\\p{Pc}";
const ALPHA = "\\p{Alphabetic}";
const SPACE = "\\p{White_Space}";
const ALNUM = "\\p{Alphabetic}\\p{Nd}";
const SEPARATORS = "_\\u00B7\\u30FB\\u200C";

/** `Tag::HASHTAG_NAME_PAT`: a name has a letter, and separators only inside it. */
const HASHTAG_NAME = `[${WORD}_][${WORD}${SEPARATORS}]*[${ALPHA}${SEPARATORS}][${WORD}${SEPARATORS}]*[${WORD}_]|[${WORD}_]*[${ALPHA}][${WORD}_]*`;

/** `Tag::HASHTAG_RE`: `#` or `＃` at the start of a line or after a space. */
const HASHTAG = new RegExp(`(?<=^|[${SPACE}])[#＃](${HASHTAG_NAME})`, "gmu");
const HASHTAG_NAME_ONLY = new RegExp(`^(?:${HASHTAG_NAME})$`, "iu");
const HASHTAG_INVALID_CHARACTERS = new RegExp(`[^${ALNUM}\\u0E47-\\u0E4E${SEPARATORS}]`, "gu");

/**
 * A tag's stored name, as Mastodon's `HashtagNormalizer`: NFKC (full-width
 * to half-width), lowercase, and only the characters a tag can hold, so
 * `#Cat`, `ＣＡＴ` and `cat!` are all `cat`. Mastodon also folds accents to
 * ASCII (`café` to `cafe`); this does not (SHR-3).
 */
export const normalizeHashtag = (raw: string): string =>
  raw.normalize("NFKC").toLowerCase().replace(HASHTAG_INVALID_CHARACTERS, "");

/** Whether a name is a hashtag's (`Tag::HASHTAG_NAME_RE`): `日本語`, `a1`, not `2024`. */
export const isHashtagName = (name: string): boolean => HASHTAG_NAME_ONLY.test(name);

/**
 * The hashtags in post text, normalized and unique, as Mastodon's
 * `Extractor.extract_hashtags` finds them. A tag right before `://` loses
 * a trailing `http` or `https` (`#tagged https://` typed without a space).
 */
export const extractHashtags = (text: string): string[] => [
  ...new Set(
    [...text.matchAll(HASHTAG)].map((match) => {
      const name = match[1] ?? "";
      const end = match.index + match[0].length;
      const beforeScheme = text.startsWith("://", end) ? /^(.+)https?$/u.exec(name) : null;
      return normalizeHashtag(beforeScheme?.[1] ?? name);
    }),
  ),
];

/** Whether post text has a hashtag, which only a public post lists under. */
export const hasHashtag = (text: string): boolean => extractHashtags(text).length > 0;
