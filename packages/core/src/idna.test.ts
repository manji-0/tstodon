import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { toAscii } from "./idna";
import { IDNA_TABLES } from "./idna-tables";
import { composeIdnaTables } from "./idna-tables.compose";
import { libidnHosts } from "./post-text.fixture";
import { statusLength } from "./post-text";

describe("toAscii", () => {
  it.each([
    ["example.com", "example.com"],
    ["例え.jp", "xn--r8jz45g.jp"],
    ["ÉCOLE.fr", "xn--cole-9oa.fr"],
    ["Straße.de", "strasse.de"],
    ["例え。jp", "xn--r8jz45g.jp"],
    ["exam\u00adple.com", "example.com"],
    ["☃.com", "xn--n3h.com"],
    ["דוגמה.com", "xn--6dbbec0c.com"],
    ["example.com.", "example.com."],
    ["EXAMPLE.com", "EXAMPLE.com"],
  ])("converts %j to %j", (domain, ascii) => {
    expect(toAscii(domain)).toBe(ascii);
  });

  it.each([
    ["an emoji Unicode 3.2 does not have", "👍.com"],
    ["a letter Unicode 3.2 does not have", "ẞ.com"],
    ["both text directions in a label", "aמ.com"],
    ["a right-to-left label that ends with a digit", "מ1.com"],
    ["a prohibited character", "a\u200eb.com"],
    ["a label that is not ASCII after the ACE prefix", "xn--例.jp"],
    ["an empty label", "a..com"],
    ["a label nameprep leaves nothing of", "\u00ad.com"],
    ["an ASCII label over 63 octets", `${"a".repeat(64)}.com`],
    ["a label over 63 octets in punycode", `${"é".repeat(58)}.com`],
  ])("refuses %s", (_, domain) => {
    expect(toAscii(domain)).toBeUndefined();
  });

  it("takes a label of 63 octets in punycode and not one of 64", () => {
    expect(toAscii("例".repeat(57))).toHaveLength(63);
    expect(toAscii("例".repeat(58))).toBeUndefined();
    // `ß` is `ss`: 62 octets, then 64.
    expect(toAscii("ß".repeat(31))).toHaveLength(62);
    expect(toAscii("ß".repeat(32))).toBeUndefined();
  });

  it("converts each host of the corpus as libidn does", () => {
    const hosts = libidnHosts();
    expect(hosts.length).toBeGreaterThan(3000);
    const mismatches = hosts.flatMap(([host, ascii]) => {
      const found = toAscii(host) ?? null;
      return found === ascii ? [] : [{ host, found, libidn: ascii }];
    });
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(mismatches).toHaveLength(0);
  });

  it("has the tables packed from RFC 3454 (else run scripts/generate-idna-tables.mjs)", () => {
    const rfc = readFileSync(new URL("./idna-tables.rfc3454.txt", import.meta.url), "utf8");
    expect(IDNA_TABLES).toEqual(composeIdnaTables(rfc));
  });

  it("refuses a long label before normalizing it", () => {
    for (const run of ["\u0f71\u0f72", "\ufdfa", "e\u0301"]) {
      expect(toAscii(`a${run.repeat(4083)}.com`), run).toBeUndefined();
      const text = `https://a${run.repeat(4083)}.com `.repeat(12);
      statusLength("", text.slice(0, 100));
      const started = performance.now();
      statusLength("", text);
      expect(performance.now() - started, run).toBeLessThan(100);
    }
  });

  it("takes linear time on a long host", () => {
    const hosts = [
      "é".repeat(50_000),
      "\u00ad".repeat(50_000),
      "가\u0301".repeat(25_000),
      "מ".repeat(50_000),
      "é.".repeat(25_000),
      "👍".repeat(25_000),
      "ﬃ".repeat(50_000),
    ];
    for (const host of hosts) {
      toAscii(host.slice(0, 100));
      const started = performance.now();
      toAscii(host);
      expect(performance.now() - started, host.slice(0, 10)).toBeLessThan(500);
    }
  });
});
