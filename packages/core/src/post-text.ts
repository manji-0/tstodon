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

const WORD_CHARACTER = new RegExp(`^[${WORD}]$`, "u");
const ALPHA_CHARACTER = new RegExp(`^[${ALPHA}]$`, "u");
const SEPARATOR_CHARACTER = new RegExp(`^[${SEPARATORS}]$`, "u");
const HASHTAG_INVALID_CHARACTERS = new RegExp(`[^${ALNUM}\\u0E47-\\u0E4E${SEPARATORS}]`, "gu");
const isWord = (c: string): boolean => WORD_CHARACTER.test(c);
const isAlpha = (c: string): boolean => ALPHA_CHARACTER.test(c);
const isSeparator = (c: string): boolean => SEPARATOR_CHARACTER.test(c);

/** A `#` or `＃` at the start of a line or after a space, and the characters a name may take after it. */
const HASHTAG_START = new RegExp(`(?<=^|[${SPACE}])[#＃]([${WORD}${ALPHA}${SEPARATORS}]*)`, "gmu");

/**
 * How many characters of `name` the first branch of `Tag::HASHTAG_NAME_PAT`
 * matches from its start, `[[:word:]_][[:word:]SEP]*[[:alpha:]SEP][[:word:]SEP]*[[:word:]_]`,
 * as the regex's backtracking would, but in linear time (the regex is
 * quadratic on a long run with no word character at its end). 0 if none.
 * The middle may hold one character that is a letter but no word character
 * (`Ⅻ`), which must be the `[[:alpha:]SEP]` one.
 */
const firstBranchLength = (name: ReadonlyArray<string>): number => {
  if (name.length < 2 || !isWord(name[0] ?? "")) {
    return 0;
  }
  let other = -1;
  let lastWord = -1;
  for (let i = 1; i < name.length; i += 1) {
    const c = name[i] ?? "";
    if (isWord(c)) {
      lastWord = i;
    } else if (!isSeparator(c)) {
      if (other !== -1 || !isAlpha(c)) {
        break;
      }
      other = i;
    }
  }
  if (lastWord < 2) {
    return 0;
  }
  if (other !== -1 && other < lastWord) {
    return lastWord + 1;
  }
  for (let i = 1; i < lastWord; i += 1) {
    const c = name[i] ?? "";
    if (isAlpha(c) || isSeparator(c)) {
      return lastWord + 1;
    }
  }
  return 0;
};

/**
 * The second branch, `[[:word:]_]*[[:alpha:]][[:word:]_]*`: the run of word
 * characters, or that run, one letter after it and the word characters after
 * that, as long as it holds a letter. 0 if none.
 */
const lastBranchLength = (name: ReadonlyArray<string>): number => {
  let run = 0;
  while (run < name.length && isWord(name[run] ?? "")) {
    run += 1;
  }
  if (run < name.length && isAlpha(name[run] ?? "")) {
    let end = run + 1;
    while (end < name.length && isWord(name[end] ?? "")) {
      end += 1;
    }
    return end;
  }
  return name.slice(0, run).some(isAlpha) ? run : 0;
};

/**
 * A tag's stored name, as Mastodon's `HashtagNormalizer`: NFKC (full-width
 * to half-width), lowercase, and only the characters a tag can hold, so
 * `#Cat`, `ＣＡＴ` and `cat!` are all `cat`. Mastodon also folds accents to
 * ASCII (`café` to `cafe`); this does not (SHR-3).
 */
export const normalizeHashtag = (raw: string): string =>
  raw.normalize("NFKC").toLowerCase().replace(HASHTAG_INVALID_CHARACTERS, "");

/** Whether a name is a hashtag's (`Tag::HASHTAG_NAME_RE`): `日本語`, `a1`, not `2024`. */
export const isHashtagName = (name: string): boolean => {
  const characters = Array.from(name);
  return (
    characters.length > 0 &&
    (firstBranchLength(characters) === characters.length || isLastBranchName(characters))
  );
};

/** Whether all of `name` is the second branch: word characters and at least one letter, at most one of them no word character. */
const isLastBranchName = (name: ReadonlyArray<string>): boolean => {
  const others = name.filter((c) => !isWord(c));
  return others.length <= 1 && others.every(isAlpha) && name.some(isAlpha);
};

/**
 * The hashtags in post text, normalized and unique, as Mastodon's
 * `Extractor.extract_hashtags` finds them. A tag right before `://` loses
 * a trailing `http` or `https` (`#tagged https://` typed without a space).
 */
export const extractHashtags = (text: string): string[] => [
  ...new Set(
    [...text.matchAll(HASHTAG_START)].flatMap((match) => {
      const run = Array.from(match[1] ?? "");
      const length = firstBranchLength(run) || lastBranchLength(run);
      const name = run.slice(0, length).join("");
      const end = match.index + 1 + name.length;
      const beforeScheme = text.startsWith("://", end) ? /^(.+)https?$/u.exec(name) : null;
      const normalized = normalizeHashtag(beforeScheme?.[1] ?? name);
      return length > 0 && isHashtagName(normalized) ? [normalized] : [];
    }),
  ),
];

/** Whether post text has a hashtag, which only a public post lists under. */
export const hasHashtag = (text: string): boolean => extractHashtags(text).length > 0;
