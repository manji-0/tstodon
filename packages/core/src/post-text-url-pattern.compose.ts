import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The source of one of twitter-text's JavaScript patterns (a `RegExp` or a string). */
const twitterText = (name: string): string => {
  const module: unknown = require(`twitter-text/dist/regexp/${name}`);
  const value =
    typeof module === "object" && module !== null && "default" in module ? module.default : module;
  if (value instanceof RegExp) {
    return value.source;
  }
  if (typeof value === "string") {
    return value;
  }
  throw new TypeError(`twitter-text/dist/regexp/${name} is not a pattern`);
};

/**
 * The characters Ruby's case-insensitive matching reads as two or three
 * ASCII letters (Unicode's full case folding), which JavaScript's does not:
 * `ﬁ` as `fi`, `ß` as `ss`.
 */
const LETTERS_AS_ONE: ReadonlyArray<readonly [letters: string, characters: string]> = [
  ["ffi", "ﬃ"],
  ["ffl", "ﬄ"],
  ["ff", "ﬀ"],
  ["fi", "ﬁ"],
  ["fl", "ﬂ"],
  ["ss", "[ßẞ]"],
  ["st", "[ﬅﬆ]"],
];

/** Every way to write `letters` with those characters (`ffi`: `ffi`, `fﬁ`, `ﬃ`, `ﬀi`). */
const spellings = (letters: string): string[] =>
  letters === ""
    ? [""]
    : [
        ...spellings(letters.slice(1)).map((rest) => letters.slice(0, 1) + rest),
        ...LETTERS_AS_ONE.filter(([folded]) => letters.startsWith(folded)).flatMap(
          ([folded, characters]) =>
            spellings(letters.slice(folded.length)).map((rest) => characters + rest),
        ),
      ];

/**
 * `source`, a pattern of words (schemes, top-level domains), matching what
 * Ruby's matches: `swiss` also as `swiß`, `fit` as `ﬁt`.
 */
const withRubyCaseFolding = (source: string): string =>
  source.replace(/(?:ff[il]?|fi|fl|s+t?)+/g, (letters) => {
    const all = spellings(letters);
    return all.length === 1 ? letters : `(?:${all.join("|")})`;
  });

/**
 * The patterns Mastodon's server finds URLs with, as sources for the `iu`
 * flags: the twitter-text gem's `valid_url` with the pieces
 * `config/initializers/twitter_regex.rb` overrides, and that file's
 * `valid_extended_uri`. The lists that change with a twitter-text release
 * (top-level domains, Latin accents) come from twitter-text's JavaScript;
 * the rest is written here as the gem has it, where the JavaScript differs
 * (`\p{Cyrillic}`, `\p{Pd}`, the characters a domain may hold, punycode).
 * `fragments` are the sources the patterns repeat, which the generator
 * writes once. Run at generation and test time only.
 */
export const composePostTextPatterns = (): {
  patterns: Record<
    | "url"
    | "schemedUrl"
    | "extraUriStart"
    | "xmppAuthority"
    | "xmppAddress"
    | "scheme"
    | "domainLabel"
    | "tld"
    | "tcoUrl",
    string
  >;
  fragments: Record<"TLD" | "URL_TAIL", string>;
} => {
  const before = twitterText("validUrlPrecedingChars");
  const latinAccents = twitterText("latinAccentChars");

  // `DOMAIN_VALID_CHARS`: not a direction mark, ASCII punctuation, a space, a
  // control character or a character twitter-text calls invalid.
  const domainChar =
    "[^\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069" +
    "!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\^_`{|}~" +
    "\\x00-\\x20\\x7F\\x85\\xA0\\u1680\\u180E\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000" +
    "\\uFFFE\\uFEFF\\uFFFF]";
  const subdomain = `(?:(?:${domainChar}(?:[_\\-]|${domainChar})*)?${domainChar}\\.)`;
  const domainName = `(?:(?:${domainChar}(?:-|${domainChar})*)?${domainChar}\\.)`;
  const tld = withRubyCaseFolding(
    `(?:${twitterText("validGTLD")}|${twitterText("validCCTLD")}|(?:xn--[0-9a-z]+))`,
  );
  const domain = `(?:${subdomain}*${domainName}${tld})`;

  const balancedParens = (pathChar: string): string =>
    `\\((?:${pathChar}+|(?:${pathChar}*\\(${pathChar}+\\)${pathChar}*))\\)`;
  // Mastodon's path characters. A path may still end with parentheses of
  // twitter-text's own path characters only: the initializer builds the
  // ending characters before it redefines the parentheses.
  const pathChar = "[^\\p{White_Space}<>()?]";
  const twitterPathChar = `[a-z\\p{Script=Cyrillic}0-9!*';:=+,.$/%#\\[\\]\\p{Pd}_~&|@${latinAccents}]`;
  const pathEnd = `[^\\p{White_Space}()?!*"'「」<>;:=,.$%\\[\\]~&|]|(?:${balancedParens(twitterPathChar)})`;
  const path = `(?:(?:${pathChar}*(?:${balancedParens(pathChar)}${pathChar}*)*(?:${pathEnd}))|(?:${pathChar}+/))`;

  const unicodeChars =
    "\\u{A0}-\\u{D7FF}\\u{F900}-\\u{FDCF}\\u{FDF0}-\\u{FFEF}\\u{10000}-\\u{1FFFD}\\u{20000}-\\u{2FFFD}\\u{30000}-\\u{3FFFD}\\u{40000}-\\u{4FFFD}\\u{50000}-\\u{5FFFD}\\u{60000}-\\u{6FFFD}\\u{70000}-\\u{7FFFD}\\u{80000}-\\u{8FFFD}\\u{90000}-\\u{9FFFD}\\u{A0000}-\\u{AFFFD}\\u{B0000}-\\u{BFFFD}\\u{C0000}-\\u{CFFFD}\\u{D0000}-\\u{DFFFD}\\u{E1000}-\\u{EFFFD}\\u{E000}-\\u{F8FF}\\u{F0000}-\\u{FFFFD}\\u{100000}-\\u{10FFFD}";
  const query = `(?:\\?[a-z0-9!?*'();:&=+$/%#\\[\\]\\-_.,~|@\\^${unicodeChars}]*[a-z0-9_&=#/\\-${unicodeChars}])`;

  const scheme = withRubyCaseFolding("(?:https?|dat|dweb|ipfs|ipns|ssb|gopher|gemini):\\/\\/");
  const urlTail = `(?<domain>${domain})(?::${twitterText("validPortNumber")})?(?:\\/${path}*)?${query}?`;

  const unreserved = "[a-z\\p{Script=Cyrillic}0-9\\p{Pd}._~]";
  const percentEncoded = "(?:%[0-9a-f]{2})";
  const nodeId = `(?:${unreserved}|${percentEncoded}|[!$()*+,;=])`;
  const resourceId = `(?:${unreserved}|${percentEncoded}|[!$&'()*+,;=])`;

  return {
    patterns: {
      // `valid_url`: the scheme is optional, as in the gem, whose extractor
      // then drops a match without one.
      url: `(?<before>${before})(?<scheme>${scheme})?${urlTail}`,
      schemedUrl: `(?<before>${before})(?<scheme>${scheme})${urlTail}`,
      // `valid_extended_uri` in three parts, `xmpp:` then an optional
      // authority then the address, or `magnet:` and its query. As one
      // pattern it holds the top-level domains twice, which is more than V8
      // compiles: it then interprets the pattern, some 50 times slower.
      extraUriStart: `(?<before>${before})(?:(?<xmpp>xmpp:)|magnet:${query})`,
      xmppAuthority: `\\/\\/${nodeId}+@${domain}\\/`,
      xmppAddress: `(?:${nodeId}+@)?${domain}(?:\\/${resourceId}+)?${query}?`,
      scheme,
      // A run of the characters a domain label holds, and the dot after it.
      domainLabel: `(?:${domainChar}|[_\\-])+\\.?`,
      tld,
      tcoUrl: "^https?:\\/\\/t\\.co\\/([a-z0-9]+)",
    },
    fragments: { TLD: tld, URL_TAIL: urlTail },
  };
};
