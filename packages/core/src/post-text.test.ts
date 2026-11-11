import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { countableText, noteLength, statusLength } from "./post-text";
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
      const specifiers = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(
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
