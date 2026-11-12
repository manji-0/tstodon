import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { toAscii } from "./idna";
import {
  countableText,
  extractEntities,
  extractHashtags,
  graphemeLength,
  isHashtagName,
  normalizeHashtag,
  noteLength,
  statusLength,
} from "./post-text";
import { mastodonPostTexts } from "./post-text.fixture";
import { POST_TEXT_PATTERNS } from "./post-text-url-pattern";
import { composePostTextPatterns } from "./post-text-url-pattern.compose";

/**
 * [content warning, text, length]: what Mastodon 4.7's `StatusLengthValidator`
 * counts. Its web UI counts some of them differently: it finds URLs with
 * twitter-text's own pattern, the server with `twitter_regex.rb`'s.
 */
const corpus: ReadonlyArray<readonly [string, string, number]> = [
  ["", "see https://example.com/path?q=1.", 28],
  ["", "https://example.com", 23],
  ["", "(https://example.com)", 25],
  ["", "foo https://example.com/a_(b)", 27],
  // The web UI counts 25: twitter-text ends the URL before `パス`.
  ["", "https://例え.jp/パス", 23],
  ["", "x https://example.com:8080/a?b=c&d=e#frag", 25],
  ["", "text:https://example.com", 28],
  ["", "@alice@example.com hi", 9],
  ["", "mail me@example.com", 19],
  ["", "a https://localhost/foo", 23],
  ["", "https://example.com/foo...", 26],
  ["", "http://a.b", 10],
  ["", "https://example.com/'quoted'", 24],
  ["", "https://example.c", 17],
  ["", "日本語https://example.com", 26],
  ["", "https://example.com/path!", 24],
  ["", "[https://example.com]", 25],
  ["", "xhttps://example.com", 20],
  ["", "https://192.168.0.1/x", 21],
  ["", "👍🏽 👨‍👩‍👧 🇯🇵", 5],
  ["", "é and é", 7],
  ["CW", "https://example.com", 25],
  ["see https://example.com/long/path", "body", 37],
  ["a", "https://example.com", 24],
  // Mastodon's web UI counts these as written, as 23 and as 37.
  ["", "gemini://example.com/a/long/capsule/path", 23],
  ["", "example.com/https://example.org/a/long/path", 43],
  ["", "https://example.com/a/long/path/パス。", 23],
  // A path ends with parentheses only around twitter-text's own path characters.
  ["", "https://example.com/Primer_(film)", 23],
  ["", "https://ja.wikipedia.org/wiki/東京_(曖昧さ回避)", 30],
  // `xmpp:` and `magnet:` are links, at their own length.
  ["", "xmpp:alice@example.com magnet:?xt=urn:btih:abc", 46],
  // A host libidn cannot convert is no URL: Unicode 3.2 has no `👍`.
  ["", "https://👍.com/", 14],
  ["", "https://☃.com/", 23],
  ["", "https://aמ.com/", 15],
  ["", "https://example.ﬁ/", 23],
];

describe("statusLength", () => {
  it.each(corpus)("counts %j + %j as %i", (spoilerText, text, length) => {
    expect(statusLength(spoilerText, text)).toBe(length);
  });

  it("pins the lengths Mastodon's server counts", () => {
    const counted = new Map(mastodonPostTexts().map(([text, , , length]) => [text, length]));
    for (const [spoilerText, text, length] of corpus) {
      expect((counted.get(text) ?? Number.NaN) + graphemeLength(spoilerText), text).toBe(length);
    }
  });

  it("takes a URL up to twitter-text's MAX_URL_LENGTH, as Mastodon's Ruby does", () => {
    const url = (length: number) =>
      `https://example.com/${"a".repeat(length - "https://example.com/".length)}`;
    expect(statusLength("", url(4096))).toBe(23);
    expect(statusLength("", url(4097))).toBe(4097);
  });

  it("counts what punycode adds to the host against MAX_URL_LENGTH", () => {
    // `例え` is `xn--r8jz45g`, 9 characters more.
    const url = (length: number) => `https://例え.jp/${"a".repeat(length - 14)}`;
    expect(statusLength("", url(4087))).toBe(23);
    expect(statusLength("", url(4088))).toBe(4088);
  });

  it("counts a URL as charactersReservedPerUrl, however long", () => {
    expect(statusLength("", `https://example.com/${"a".repeat(200)}?q=1`)).toBe(23);
  });
});

describe("countableText", () => {
  it("counts a remote mention without its domain", () => {
    expect(countableText("hi @alice@social.example.org!")).toBe("hi @alice!");
    expect(countableText("@bob")).toBe("@bob");
  });

  it("is the same on every call (the patterns keep no state)", () => {
    const text = "a https://example.com b https://example.org xmpp:a@example.com";
    expect(countableText(text)).toBe(countableText(text));
    expect(extractEntities(text)).toEqual(extractEntities(text));
  });

  it("counts text of spaces only as none", () => {
    expect(countableText(" \n\u3000")).toBe("");
  });
});

describe("noteLength", () => {
  it("counts a note as a status body", () => {
    expect(noteLength("👍🏽 https://example.com")).toBe(25);
  });
});

describe("post-text module", () => {
  it("has the URL patterns composed from twitter-text (else run scripts/generate-post-text-url-pattern.mjs)", () => {
    expect(POST_TEXT_PATTERNS).toEqual(composePostTextPatterns().patterns);
  });

  it("imports only relative modules, so the web UI loads no Zod with it", () => {
    const imports = (file: string): string[] => {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const specifiers = [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*"([^"]+)"/g)].map(
        (m) => m[1] ?? "",
      );
      return specifiers.flatMap((specifier) =>
        specifier.startsWith("./") ? [specifier, ...imports(`${specifier}.ts`)] : [specifier],
      );
    };
    expect(imports("./post-text.ts").filter((specifier) => !specifier.startsWith("./"))).toEqual(
      [],
    );
  });
});

describe("extractHashtags", () => {
  it.each([
    ["#日本語 です", ["日本語"]],
    ["Hello #WaveA and #wavea", ["wavea"]],
    ["＃ＣＡＴ", ["cat"]],
    ["#a・b #a·b", ["a・b", "a·b"]],
    ["#123 #a1 #1a #_x #_", ["a1", "1a", "_x"]],
    ["word#token (#paren) a/#path", []],
    ["#tagged https://example.com", ["tagged"]],
    ["#taggedhttps://example.com", ["tagged"]],
  ])("finds the tags in %j as Mastodon's Extractor: %j", (text, tags) => {
    expect(extractHashtags(text)).toEqual(tags);
  });
});

describe("normalizeHashtag and isHashtagName", () => {
  it("normalizes as HashtagNormalizer", () => {
    expect(normalizeHashtag("#Cat!")).toBe("cat");
    expect(normalizeHashtag("ＣＡＴ")).toBe("cat");
  });

  // What Ruby 3.3 returns for Mastodon v4.7.5's `HashtagNormalizer#normalize`.
  it.each([
    ["café", "cafe"],
    ["Café", "cafe"],
    // A decomposed accent composes under NFKC, then folds.
    ["cafe\u0301", "cafe"],
    ["ÅNGSTRÖM", "angstrom"],
    ["Łódź", "lodz"],
    ["Đặng", "dặng"],
    ["straße", "straße"],
    ["æsir", "æsir"],
    ["þór", "þor"],
    // Outside Latin-1 and Latin Extended-A: not in the table.
    ["ǎ", "ǎ"],
    ["ё", "ё"],
    ["İstanbul", "istanbul"],
    ["ısı", "isi"],
    // NFKC decomposes it before the fold could read it.
    ["ŉ", "\u02BCn"],
    ["ĸ", "k"],
    ["ſ", "s"],
    ["ｃａｆé", "cafe"],
    ["日本語", "日本語"],
    // Unlike Ruby's `downcase`, a final `Σ` is `ς` (SHR-8): stored names keep reading.
    ["ΟΔΟΣ", "οδος"],
    ["οδος", "οδος"],
  ])("folds accents as ASCIIFolding: %s is %s", (raw, name) => {
    expect(normalizeHashtag(raw)).toBe(name);
  });

  it("extracts an accented tag under its folded name", () => {
    expect(extractHashtags("un #Café et un #cafe")).toEqual(["cafe"]);
  });

  it("leaves every stored ASCII name as it is", () => {
    for (const name of ["cat", "a_1", "_x", "2024a"]) {
      expect(normalizeHashtag(name)).toBe(name);
    }
  });

  it("takes a name with a letter", () => {
    expect(isHashtagName("日本語")).toBe(true);
    expect(isHashtagName("a1")).toBe(true);
    expect(isHashtagName("2024")).toBe(false);
    expect(isHashtagName("")).toBe(false);
  });
});

describe("hashtag matching against Mastodon's regex", () => {
  const WORD = "\\p{L}\\p{M}\\p{Nd}\\p{Pc}";
  const ALPHA = "\\p{Alphabetic}";
  const SEP = "_\\u00B7\\u30FB\\u200C";
  const NAME = `[${WORD}_][${WORD}${SEP}]*[${ALPHA}${SEP}][${WORD}${SEP}]*[${WORD}_]|[${WORD}_]*[${ALPHA}][${WORD}_]*`;
  const HASHTAG_RE = new RegExp(`(?<=^|[\\p{White_Space}])[#＃](${NAME})`, "gmu");
  const NAME_RE = new RegExp(`^(?:${NAME})$`, "iu");
  const reference = (text: string): string[] => [
    ...new Set(
      [...text.matchAll(HASHTAG_RE)].flatMap((match) => {
        const name = match[1] ?? "";
        const end = match.index + match[0].length;
        const cut = text.startsWith("://", end) ? /^(.+)https?$/u.exec(name) : null;
        const normalized = normalizeHashtag(cut?.[1] ?? name);
        return NAME_RE.test(normalized) ? [normalized] : [];
      }),
    ),
  ];
  const alphabet = [
    "a",
    "Z",
    "1",
    "_",
    "·",
    "・",
    "‌",
    "Ⅻ",
    "Ⓐ",
    "é",
    "́",
    " ",
    "\n",
    "#",
    "＃",
    ":",
    "/",
    "h",
    "t",
    "p",
    "s",
    "-",
  ];
  let seed = 1;
  const random = (n: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed % n;
  };

  it("finds what Tag::HASHTAG_RE finds, on 20,000 random texts", () => {
    for (let i = 0; i < 20_000; i += 1) {
      const text = Array.from(
        { length: 1 + random(14) },
        () => alphabet[random(alphabet.length)],
      ).join("");
      expect(extractHashtags(text), JSON.stringify(text)).toEqual(reference(text));
      expect(isHashtagName(text), JSON.stringify(text)).toBe(NAME_RE.test(text));
    }
  });

  it("takes linear time where the regex backtracks", () => {
    for (const filler of ["·", "‌"]) {
      const text = `#1${filler.repeat(50_000)}Ⅻ`;
      const started = performance.now();
      extractHashtags(text);
      isHashtagName(text.slice(1));
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
});

describe("extractEntities", () => {
  const url = (start: number, end: number, value: string) =>
    ({ kind: "Url", start, end, url: value }) as const;
  const hashtag = (start: number, end: number, name: string) =>
    ({ kind: "Hashtag", start, end, name }) as const;
  const mention = (start: number, end: number, username: string, domain?: string) =>
    domain === undefined
      ? ({ kind: "Mention", start, end, username } as const)
      : ({ kind: "Mention", start, end, username, domain } as const);

  it.each([
    ["plain text", []],
    [
      "hi @Bob #Cat https://example.com/a",
      [mention(3, 7, "Bob"), hashtag(8, 12, "Cat"), url(13, 34, "https://example.com/a")],
    ],
    ["(https://example.com).", [url(1, 20, "https://example.com")]],
    [
      "@a@b.c, @x.y-z@Ex-ample.org!",
      [mention(0, 6, "a", "b.c"), mention(8, 27, "x.y-z", "Ex-ample.org")],
    ],
    [
      "@a@localhost @a. @a-",
      [mention(0, 12, "a", "localhost"), mention(13, 15, "a"), mention(17, 19, "a")],
    ],
    ["me@example.com =@a /@a _@a", []],
    ["@a@ @bé @c://x @d@e@f", []],
    ["https://x.example/@a@b.c #t", [hashtag(25, 27, "t")]],
    [
      "https://example.com/@a@b.c #t",
      [url(0, 26, "https://example.com/@a@b.c"), hashtag(27, 29, "t")],
    ],
    ["https://example.com/(@a) @b", [url(0, 24, "https://example.com/(@a)"), mention(25, 27, "b")]],
    ["#taggedhttps://x", [hashtag(0, 7, "tagged")]],
    ["#tagged https://example.com", [hashtag(0, 7, "tagged"), url(8, 27, "https://example.com")]],
    ["👍🏽 #日本語 @a", [hashtag(5, 9, "日本語"), mention(10, 12, "a")]],
    ["#123 ＃ＣＡＴ", [hashtag(5, 9, "ＣＡＴ")]],
    ["https://例え.jp/パス。 ", [url(0, 17, "https://例え.jp/パス。")]],
    ["https://example.com/パス!", [url(0, 22, "https://example.com/パス")]],
    ["gemini://example.com/a ftp://example.com", [url(0, 22, "gemini://example.com/a")]],
    ["example.com/https://example.org", []],
    ["https://t.co/abc/def", [url(0, 16, "https://t.co/abc")]],
    [
      "xmpp:alice@example.com/phone magnet:?xt=urn:btih:abc.",
      [url(0, 28, "xmpp:alice@example.com/phone"), url(29, 52, "magnet:?xt=urn:btih:abc")],
    ],
    [
      "xmpp://guest@example.com/support@example.org?message",
      [url(0, 52, "xmpp://guest@example.com/support@example.org?message")],
    ],
    ["xmpp:alice axmpp:a@example.com", []],
    ["#a·gemini://example.com", [hashtag(0, 9, "a·gemini")]],
  ])("finds the entities in %j", (text, entities) => {
    expect(extractEntities(text)).toEqual(entities);
  });

  it("drops a mention whose domain is longer than a domain name", () => {
    expect(extractEntities(`@a@${"b".repeat(254)}`)).toEqual([]);
    expect(extractEntities(`@a@${"b".repeat(253)}`)).toHaveLength(1);
  });

  it("counts a mention inside a URL as the URL", () => {
    expect(countableText("https://example.com/(@a@b.c) @a@b.c")).toBe(`${"x".repeat(23)} @a`);
  });

  it("drops a URL longer than twitter-text's 4096 characters", () => {
    const url = (length: number) => `https://example.com/${"a".repeat(length - 20)}`;
    expect(extractEntities(url(4096))).toHaveLength(1);
    expect(extractEntities(url(4097))).toEqual([]);
  });

  it("takes linear time on a long run of mention separators", () => {
    const started = performance.now();
    extractEntities(`@a${".-".repeat(50_000)}!`);
    extractEntities("@a".repeat(50_000));
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("URL matching against the plain scan", () => {
  // twitter-text's own scan: the pattern at every index. A match without a
  // scheme or with a host libidn refuses is no URL, and nothing inside it is one.
  const plainScan = (text: string): ReadonlyArray<readonly [number, number]> =>
    [...text.matchAll(new RegExp(POST_TEXT_PATTERNS.url, "giu"))].flatMap((match) =>
      match.groups?.["scheme"] === undefined || toAscii(match.groups["domain"] ?? "") === undefined
        ? []
        : [
            [
              match.index + (match.groups["before"] ?? "").length,
              match.index + match[0].length,
            ] as const,
          ],
    );
  const tokens = [
    ...Array.from("aZ1é例👍-_.:/?()! \n"),
    ".",
    ".",
    ".com",
    ".com",
    ".jp",
    ".c",
    "xn--",
    "https://",
    "https://",
    "gemini://",
    "http",
    "://",
    ":80",
  ];
  let seed = 7;
  const random = (n: number): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };

  // A correctness sweep, not a timing check: 3 to 5 s alone, past the 5 s
  // default when the whole suite shares the machine.
  it("finds the URLs the plain scan finds, on 30,000 random texts", { timeout: 30_000 }, () => {
    for (let i = 0; i < 30_000; i += 1) {
      const text = Array.from({ length: 1 + random(16) }, () => tokens[random(tokens.length)]).join(
        "",
      );
      expect(
        extractEntities(text).map((entity) => [entity.start, entity.end]),
        JSON.stringify(text),
      ).toEqual(plainScan(text));
    }
  });

  it("takes linear time where the plain scan is quadratic or the pattern backtracks", () => {
    const fill = (unit: string): string => unit.repeat(Math.ceil(50_000 / unit.length));
    const texts = [
      fill("é."),
      fill("é"),
      fill("é_é.") + "com",
      fill("é.comx."),
      fill("é.xn--"),
      fill("👍."),
      fill("a.co "),
      fill("https://"),
      `https://example.com/${fill("(")}`,
      `https://example.com/${fill("(a")}`,
      `https://example.com/${fill("((a)")}`,
      `https://example.com/${fill("(あ).")}`,
      `https://example.com/${fill(".")}`,
      `https://example.com/?${fill("!")}`,
      `xmpp:${fill("a.")}`,
      `xmpp:${fill("a")}`,
      fill("xmpp://a@"),
      `magnet:?${fill("!")}`,
      // Hosts that are not ASCII, which nameprep and punycode read.
      `https://${fill("é")}.com/`,
      `https://${fill("\u00ad")}.com/`,
      `https://${fill("가\u0301")}.com/`,
      `https://${fill("é.")}com/`,
      fill("https://é.com/ "),
      fill("https://👍.com/"),
      fill(`https://${"é".repeat(57)}.com `),
      fill(`https://${"例".repeat(20)}.${"え".repeat(20)}.jp/`),
    ];
    for (const text of texts) {
      extractEntities(text.slice(0, 100));
      const started = performance.now();
      extractEntities(text);
      countableText(text);
      expect(performance.now() - started, text.slice(0, 40)).toBeLessThan(500);
    }
  });
});
