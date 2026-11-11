import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  countableText,
  extractEntities,
  extractHashtags,
  isHashtagName,
  normalizeHashtag,
  noteLength,
  statusLength,
} from "./post-text";
import { POST_URL_PATTERN } from "./post-text-url-pattern";
import { composePostUrlPattern } from "./post-text-url-pattern.compose";

/**
 * [content warning, text, length]: what Mastodon 4.7's web UI counted
 * (twitter-text's URLs, `stringz` graphemes) before it shared this module,
 * which is what `StatusLengthValidator` counts.
 */
const corpus: ReadonlyArray<readonly [string, string, number]> = [
  ["", "see https://example.com/path?q=1.", 28],
  ["", "https://example.com", 23],
  ["", "(https://example.com)", 25],
  ["", "foo https://example.com/a_(b)", 27],
  ["", "https://例え.jp/パス", 25],
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
];

describe("statusLength", () => {
  it.each(corpus)("counts %j + %j as %i", (spoilerText, text, length) => {
    expect(statusLength(spoilerText, text)).toBe(length);
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

  it("is the same on every call (the global pattern keeps no state)", () => {
    const text = "a https://example.com b https://example.org";
    expect(countableText(text)).toBe(countableText(text));
  });
});

describe("noteLength", () => {
  it("counts a note as a status body", () => {
    expect(noteLength("👍🏽 https://example.com")).toBe(25);
  });
});

describe("post-text module", () => {
  it("has the URL pattern twitter-text composes (else run scripts/generate-post-text-url-pattern.mjs)", () => {
    expect(POST_URL_PATTERN).toEqual(composePostUrlPattern());
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
  it("normalizes as HashtagNormalizer, without accent folding", () => {
    expect(normalizeHashtag("#Cat!")).toBe("cat");
    expect(normalizeHashtag("ＣＡＴ")).toBe("cat");
    expect(normalizeHashtag("café")).toBe("café");
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

  it("takes linear time on a long run of mention separators", () => {
    const started = performance.now();
    extractEntities(`@a${".-".repeat(50_000)}!`);
    extractEntities("@a".repeat(50_000));
    expect(performance.now() - started).toBeLessThan(500);
  });
});
