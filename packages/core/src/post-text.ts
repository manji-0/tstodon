import { toAscii } from "./idna";
import { InstanceLimits } from "./instance-limits";
import { POST_TEXT_PATTERNS } from "./post-text-url-pattern";

/**
 * How Mastodon's server reads post text: what it counts against a length
 * limit and what it links. Shared by the Worker (which enforces the limits
 * and writes the HTML) and the web UI (which shows what is left). It imports
 * no Zod, so the web UI can load it: `@tstodon/core/post-text`.
 */

/**
 * A URL with a scheme in post text, for taking URLs out of it (`replace`,
 * which resets `lastIndex`); the match starts with the character before the
 * URL. `extractEntities` is what finds the URLs Mastodon links.
 */
export const postUrlRegex = new RegExp(POST_TEXT_PATTERNS.schemedUrl, "giu");

const URL_PLACEHOLDER = "x".repeat(InstanceLimits.status.charactersReservedPerUrl);

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
const BLANK = new RegExp(`^[${SPACE}]*$`, "u");
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
 * A link Mastodon makes of post text, with UTF-16 indices into it
 * (`Extractor.extract_entities_with_indices`). A hashtag's `name` and a
 * mention's `username` and `domain` are as written; `start` is at the `#`
 * or `@`.
 */
export type PostEntity =
  | { readonly kind: "Url"; readonly start: number; readonly end: number; readonly url: string }
  | {
      readonly kind: "Hashtag";
      readonly start: number;
      readonly end: number;
      readonly name: string;
    }
  | {
      readonly kind: "Mention";
      readonly start: number;
      readonly end: number;
      readonly username: string;
      readonly domain?: string;
    };

type EntityOf<Kind extends PostEntity["kind"]> = Extract<PostEntity, { kind: Kind }>;

const URL_AT = new RegExp(POST_TEXT_PATTERNS.url, "iuy");
const TCO_URL = new RegExp(POST_TEXT_PATTERNS.tcoUrl, "iu");
const EXTRA_URI_START = new RegExp(POST_TEXT_PATTERNS.extraUriStart, "giu");
const XMPP_AUTHORITY = new RegExp(POST_TEXT_PATTERNS.xmppAuthority, "iuy");
const XMPP_ADDRESS = new RegExp(POST_TEXT_PATTERNS.xmppAddress, "iuy");
const SCHEME = new RegExp(POST_TEXT_PATTERNS.scheme, "giu");
const DOMAIN_LABEL = new RegExp(POST_TEXT_PATTERNS.domainLabel, "gu");
const TLD_AT = new RegExp(POST_TEXT_PATTERNS.tld, "iuy");
/** twitter-text's `MAX_URL_LENGTH` and `MAX_TCO_SLUG_LENGTH`. */
const MAX_URL_LENGTH = 4096;
const MAX_TCO_SLUG_LENGTH = 40;

const isLowSurrogate = (text: string, index: number): boolean =>
  (text.charCodeAt(index) & 0xfc00) === 0xdc00 && (text.charCodeAt(index - 1) & 0xfc00) === 0xd800;

/**
 * The indices of `text` where `URL_AT` can match: one character before a
 * domain, or before a scheme and a domain. `URL_AT` matches from a domain
 * without a scheme too, as twitter-text's `valid_url`, so trying it at every
 * index walks a run of labels with no top-level domain (`é.é.é.…`) once per
 * label, which is quadratic. This finds where a domain starts in one pass
 * from the right: a label starts one if it ends at a top-level domain, or at
 * a label that starts one.
 */
const urlAttempts = (text: string): Uint8Array => {
  const domainStarts = new Uint8Array(text.length + 1);
  const attempts = new Uint8Array(text.length + 1);
  const attemptBefore = (index: number): void => {
    attempts[Math.max(0, index - (isLowSurrogate(text, index - 1) ? 2 : 1))] = 1;
  };
  let next = { start: -1, startsDomain: false };
  for (const match of [...text.matchAll(DOMAIN_LABEL)].reverse()) {
    const label = match[0];
    const dot = match.index + label.length - 1;
    if (!label.endsWith(".") || /[_-]\.$/.test(label)) {
      continue;
    }
    TLD_AT.lastIndex = dot + 1;
    // An underscore may be in a subdomain, not in the name before the top-level domain.
    const first =
      next.start === dot + 1 && next.startsDomain
        ? 0
        : TLD_AT.test(text)
          ? label.lastIndexOf("_") + 1
          : label.length;
    for (let i = first; i < label.length - 1; i += 1) {
      const index = match.index + i;
      if (label[i] !== "-" && label[i] !== "_" && !isLowSurrogate(text, index)) {
        domainStarts[index] = 1;
        attemptBefore(index);
      }
    }
    next = { start: match.index, startsDomain: domainStarts[match.index] === 1 };
  }
  for (const match of text.matchAll(SCHEME)) {
    if (domainStarts[match.index + match[0].length] === 1) {
      attemptBefore(match.index);
    }
  }
  return attempts;
};

const codePointLength = (text: string): number => {
  let length = text.length;
  for (let index = 1; index < text.length; index += 1) {
    if (isLowSurrogate(text, index)) {
      length -= 1;
    }
  }
  return length;
};

/**
 * twitter-text's `is_valid_domain`: the host converts to ASCII (IDNA2003, as
 * libidn's `IDN::Idna.toASCII`), and the URL is at most `MAX_URL_LENGTH`
 * characters with what the conversion adds to the host. So
 * `https://👍.com`, whose host Unicode 3.2 does not have, is no URL.
 */
const isValidDomain = (url: string, domain: string): boolean => {
  const length = codePointLength(url);
  if (length > MAX_URL_LENGTH) {
    return false;
  }
  const ascii = toAscii(domain);
  return (
    ascii !== undefined &&
    length + Math.max(0, ascii.length - codePointLength(domain)) <= MAX_URL_LENGTH
  );
};

/**
 * The URLs Mastodon counts as `charactersReservedPerUrl` characters
 * (`Extractor.extract_urls_with_indices` without the URLs that have no
 * scheme). A match without a scheme is no URL, but a URL inside it is none
 * either: `example.com/https://example.org` has no URL. A `t.co` link ends
 * after its slug.
 */
const urlEntities = (text: string): EntityOf<"Url">[] => {
  const attempts = urlAttempts(text);
  const urls: EntityOf<"Url">[] = [];
  let matchedTo = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (attempts[index] !== 1 || index < matchedTo) {
      continue;
    }
    URL_AT.lastIndex = index;
    const match = URL_AT.exec(text);
    if (match === null) {
      continue;
    }
    matchedTo = index + match[0].length;
    if (match.groups?.["scheme"] === undefined) {
      continue;
    }
    const start = index + (match.groups["before"] ?? "").length;
    const matched = text.slice(start, matchedTo);
    const tco = TCO_URL.exec(matched);
    const url = tco?.[0] ?? matched;
    if (
      (tco?.[1] ?? "").length <= MAX_TCO_SLUG_LENGTH &&
      isValidDomain(url, match.groups["domain"] ?? "")
    ) {
      urls.push({ kind: "Url", start, end: start + url.length, url });
    }
  }
  return urls;
};

/** Where `pattern` (sticky) ends when it matches `text` at `index`. */
const endOfMatchAt = (pattern: RegExp, text: string, index: number): number | undefined => {
  pattern.lastIndex = index;
  return pattern.test(text) ? pattern.lastIndex : undefined;
};

/** Where the `xmpp:` URI ends whose `xmpp:` ends at `index`: after its address, which may follow an authority (`//guest@example.com/`). */
const xmppEnd = (text: string, index: number): number | undefined => {
  const authority = endOfMatchAt(XMPP_AUTHORITY, text, index);
  return (
    (authority === undefined ? undefined : endOfMatchAt(XMPP_ADDRESS, text, authority)) ??
    endOfMatchAt(XMPP_ADDRESS, text, index)
  );
};

/** The `xmpp:` and `magnet:` URIs Mastodon links but counts as written (`Extractor.extract_extra_uris_with_indices`). */
const extraUriEntities = (text: string): EntityOf<"Url">[] => {
  const uris: EntityOf<"Url">[] = [];
  EXTRA_URI_START.lastIndex = 0;
  for (let match = EXTRA_URI_START.exec(text); match !== null; match = EXTRA_URI_START.exec(text)) {
    const start = match.index + (match.groups?.["before"] ?? "").length;
    const matchedTo = match.index + match[0].length;
    const end = match.groups?.["xmpp"] === undefined ? matchedTo : xmppEnd(text, matchedTo);
    if (end === undefined) {
      // No URI here: look on after the `x`, which nothing can start at or follow.
      EXTRA_URI_START.lastIndex = start + 1;
    } else {
      uris.push({ kind: "Url", start, end, url: text.slice(start, end) });
      EXTRA_URI_START.lastIndex = end;
    }
  }
  return uris;
};

/**
 * A tag right before `://` loses a trailing `http` or `https` (`#tagged
 * https://` typed without a space). A name that normalizes to none a tag
 * can have is no hashtag.
 */
const hashtagEntities = (text: string): EntityOf<"Hashtag">[] =>
  [...text.matchAll(HASHTAG_START)].flatMap((match) => {
    const run = Array.from(match[1] ?? "");
    const length = firstBranchLength(run) || lastBranchLength(run);
    const matched = run.slice(0, length).join("");
    const beforeScheme = text.startsWith("://", match.index + 1 + matched.length)
      ? /^(.+)https?$/u.exec(matched)
      : null;
    const name = beforeScheme?.[1] ?? matched;
    return length > 0 && isHashtagName(normalizeHashtag(name))
      ? [{ kind: "Hashtag", start: match.index, end: match.index + 1 + name.length, name }]
      : [];
  });

/**
 * Mastodon's `Account::MENTION_RE`: `$1` the username, `$2` the domain.
 * Case-insensitive as Ruby's, so `[a-z]` takes `ſ` and `K` (Kelvin) too.
 * Unlike Mastodon, the domain may carry a port (`@bob@127.0.0.1:8792`), as
 * tstodon keeps an actor's `host:port` authority as its domain.
 */
const MENTION = new RegExp(
  `(?<![=/${WORD}])@([a-z0-9_]+(?:[.-]+[a-z0-9_]+)*)(?:@([${WORD}]+(?:[.-]+[${WORD}]+)*(?::\\d{1,5})?))?`,
  "giu",
);
/** What may not follow a mention (twitter-text's `end_mention_match`): `@`, a Latin accented letter, `://`. */
const LATIN_ACCENTS =
  "\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u00FF\\u0100-\\u024F\\u0253\\u0254\\u0256\\u0257\\u0259\\u025B\\u0263\\u0268\\u026F\\u0272\\u0289\\u028B\\u02BB\\u0300-\\u036F\\u1E00-\\u1EFF";
const AFTER_MENTION = new RegExp(`^(?:[@＠${LATIN_ACCENTS}]|://)`, "u");
const MAX_DOMAIN_LENGTH = 253;

const mentionEntities = (text: string): EntityOf<"Mention">[] =>
  [...text.matchAll(MENTION)].flatMap((match) => {
    const username = match[1] ?? "";
    const domain = match[2];
    const end = match.index + match[0].length;
    if (
      AFTER_MENTION.test(text.slice(end, end + 3)) ||
      (domain !== undefined && domain.length > MAX_DOMAIN_LENGTH)
    ) {
      return [];
    }
    const mention = { kind: "Mention", start: match.index, end, username } as const;
    return [domain === undefined ? mention : { ...mention, domain }];
  });

/** In text order, without an entity that starts inside an earlier one (twitter-text's `remove_overlapping_entities`). */
const withoutOverlaps = <Entity extends PostEntity>(entities: ReadonlyArray<Entity>): Entity[] => {
  let end = 0;
  return [...entities]
    .sort((a, b) => a.start - b.start)
    .filter((entity) => {
      if (entity.start < end) {
        return false;
      }
      end = entity.end;
      return true;
    });
};

/**
 * The URLs, hashtags and mentions Mastodon links in post text, in text
 * order (`Extractor.extract_entities_with_indices`).
 */
export const extractEntities = (text: string): PostEntity[] =>
  withoutOverlaps([
    ...urlEntities(text),
    ...hashtagEntities(text),
    ...mentionEntities(text),
    ...extraUriEntities(text),
  ]);

/**
 * The text Mastodon counts: each URL is `charactersReservedPerUrl`
 * characters long, but an `xmpp:` or `magnet:` URI counts as written, and a
 * mention counts without its domain. Text of spaces only counts as none
 * (`StatusLengthValidator#countable_text`).
 */
export const countableText = (text: string): string => {
  if (BLANK.test(text)) {
    return "";
  }
  let counted = "";
  let index = 0;
  for (const entity of withoutOverlaps([...urlEntities(text), ...mentionEntities(text)])) {
    counted += text.slice(index, entity.start);
    counted += entity.kind === "Url" ? URL_PLACEHOLDER : `@${entity.username}`;
    index = entity.end;
  }
  return counted + text.slice(index);
};

/**
 * The hashtags in post text, normalized and unique, as Mastodon's
 * `Extractor.extract_hashtags` finds them.
 */
export const extractHashtags = (text: string): string[] => [
  ...new Set(hashtagEntities(text).map((entity) => normalizeHashtag(entity.name))),
];

/** Whether post text has a hashtag, which only a public post lists under. */
export const hasHashtag = (text: string): boolean => extractHashtags(text).length > 0;
