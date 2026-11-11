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
