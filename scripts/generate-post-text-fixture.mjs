#!/usr/bin/env node
// Writes packages/core/src/post-text.fixture.json and idna.fixture.json:
// what Mastodon's server finds in a corpus of post texts, and what libidn
// makes of a corpus of hosts, for packages/core/src/post-text.fixture.test.ts
// and idna.test.ts to hold `@tstodon/core/post-text` to. Run once per
// Mastodon release; the tests need no Ruby. It runs
// scripts/post-text-reference.rb, which says what it needs:
//
//   MASTODON_SRC=../mastodon node scripts/generate-post-text-fixture.mjs
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));

/** The posts `post-text.test.ts` pins a length for. */
const pinned = [
  "see https://example.com/path?q=1.",
  "https://example.com",
  "(https://example.com)",
  "foo https://example.com/a_(b)",
  "https://例え.jp/パス",
  "x https://example.com:8080/a?b=c&d=e#frag",
  "text:https://example.com",
  "@alice@example.com hi",
  "mail me@example.com",
  "a https://localhost/foo",
  "https://example.com/foo...",
  "http://a.b",
  "https://example.com/'quoted'",
  "https://example.c",
  "日本語https://example.com",
  "https://example.com/path!",
  "[https://example.com]",
  "xhttps://example.com",
  "https://192.168.0.1/x",
  "👍🏽 👨‍👩‍👧 🇯🇵",
  "e\u0301 and é",
  "see https://example.com/long/path",
  "body",
  "gemini://example.com/a/long/capsule/path",
  "example.com/https://example.org/a/long/path",
  "https://example.com/a/long/path/パス。",
  "https://example.com/Primer_(film)",
  "https://ja.wikipedia.org/wiki/東京_(曖昧さ回避)",
  "xmpp:alice@example.com magnet:?xt=urn:btih:abc",
  "https://👍.com/",
  "https://☃.com/",
  "https://aמ.com/",
  "https://example.ﬁ/",
  // And its entity table's URLs.
  "https://例え.jp/パス。 ",
  "https://example.com/パス!",
  "gemini://example.com/a ftp://example.com",
  "example.com/https://example.org",
  "xmpp:alice@example.com/phone magnet:?xt=urn:btih:abc.",
  "xmpp://guest@example.com/support@example.org?message",
  "xmpp:alice axmpp:a@example.com",
];

const cases = [
  // Paths: any character but a space and `<>()?`, balanced parentheses, what a path may end with.
  "https://example.com/パス/ページ",
  "https://example.com/a_(b_(c))",
  "https://example.com/a_(b_(c_(d)))",
  "https://example.com/(a)(b)",
  "https://example.com/a(b",
  "https://example.com/a)b",
  "https://example.com/(パス)",
  "https://example.com/(パス).",
  "(see https://example.com/a)",
  "https://example.com/a, https://example.org/b.",
  'a "https://example.com/a" b',
  "「https://example.com/パス」",
  "https://example.com/a…",
  "https://example.com/a。b",
  "https://example.com/a!?",
  "https://example.com/a?",
  "https://example.com/a;b:c=d",
  "https://example.com/a<b>",
  "https://example.com/~user/",
  "https://example.com/a%20b",
  "https://example.com/a|b",
  "https://example.com/👍",
  "https://example.com/a\u3000b",
  "https://example.com/a\nb",
  "https://example.com//",
  "https://example.com/.",
  "https://example.com/a/.b/",
  // Queries.
  "https://example.com?q=1",
  "https://example.com/?q=日本語",
  "https://example.com/?q=日本語。",
  "https://example.com/?a=(b)",
  "https://example.com/?q=a.",
  "https://example.com/?",
  "https://example.com/a?b?c",
  "https://example.com/#frag?x",
  // Hosts.
  "https://example.com:8080",
  "https://example.com:8080/a",
  "https://example.com:x",
  "https://192.168.0.1:3000/x",
  "http://127.0.0.1",
  "http://[::1]/x",
  "https://localhost:3000/x",
  "https://social.example/@alice",
  "https://example.invalid/x",
  "https://example.museum/x",
  "https://example.co.uk/x",
  "https://sub_domain.example.com/x",
  "https://exa_mple.com/x",
  "https://-example.com/x",
  "https://example-.com/x",
  "https://example.com./x",
  "https://example..com/x",
  "https://EXAMPLE.COM/A",
  "HTTPS://example.com/a",
  "https://例え.テスト/x",
  "https://日本語.jp",
  "https://example.みんな/x",
  "https://xn--r8jz45g.jp/x",
  "https://example.xn--zckzah/x",
  'https://exa"mple.com/x',
  "https://exa`mple.com/x",
  "https://exa\\mple.com/x",
  "https://user:pass@example.com/x",
  "https://example.com@example.org/x",
  // Full-width and other look-alikes.
  "ｈｔｔｐｓ://example.com",
  "https：//example.com",
  "https://example．com",
  "https://ｅｘａｍｐｌｅ.com/ｐａｔｈ",
  "https://example.com／path",
  // What may be before a URL.
  "ahttps://example.com",
  "1https://example.com",
  "_https://example.com",
  "@https://example.com",
  "#https://example.com",
  "$https://example.com",
  "。https://example.com",
  "\u200ehttps://example.com",
  "\ufeffhttps://example.com",
  "https://example.comhttps://example.org",
  "https://example.com/https://example.org",
  "https://example.com https://example.org",
  // No scheme, and a URL inside a match that has none.
  "example.com/path",
  "www.example.com",
  "example.com/https://example.org x",
  "web.archive.org/web/2020/https://example.com/a",
  "example.com?u=https://example.org",
  "a.b https://example.com",
  // Other schemes.
  "gemini://example.com/x",
  "gopher://example.com:70/1",
  "ipfs://example.com/x",
  "ipns://example.com",
  "dat://example.com/x",
  "dweb://example.com/x",
  "ssb://example.com/x",
  "ftp://example.com/x",
  "mailto:alice@example.com",
  "GEMINI://example.com",
  // t.co.
  "https://t.co/abc123",
  "https://t.co/abc/def",
  "https://t.co/abc?x=1",
  `https://t.co/${"a".repeat(41)}`,
  "https://tt.co/abc/def",
  // xmpp: and magnet:.
  "xmpp:alice@example.com",
  "xmpp:example.com",
  "xmpp:alice@example.com/resource",
  "xmpp:alice@example.com?message",
  "xmpp://guest@example.com/support@example.com?message",
  "xmpp:room@conference.example.com?join.",
  "(xmpp:alice@example.com)",
  "axmpp:alice@example.com",
  "XMPP:alice@example.com",
  "xmpp:alice@localhost",
  "xmpp:a%20b@example.com",
  "magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=name",
  "magnet:?xt=urn:btih:abc.",
  "magnet:xt=urn:btih:abc",
  "see magnet:?a=b and xmpp:a@example.com and https://example.com",
  "https://example.com/xmpp:a@example.com",
  "magnet:?u=https://example.com/a",
  // With hashtags and mentions.
  "#tag https://example.com/#tag @alice@example.com",
  "https://example.com/@alice #tag",
  "#a·gemini://example.com",
  "@alice https://example.com/@bob@example.org",
  // Not posts: nothing but spaces counts as nothing.
  "",
  " \n\t",
  "\u3000",
];

const tokens = [
  ...Array.from("aZz019-_.,:;!?'\"()[]<>&=%#@/\\|~*+$`^{} \n\t"),
  ...Array.from("éſKфԁ例パ・ー。「」…—–\u00a0\u3000\u200e\ufeff\u0301ａ．／：？＃＠👍\u200d"),
  "https://",
  "https://",
  "https://",
  "http://",
  "HTTPS://",
  "gemini://",
  "ipfs://",
  "ftp://",
  "://",
  "//",
  "xmpp:",
  "xmpp://",
  "magnet:?",
  "magnet:",
  "example",
  "example.com",
  "example.com",
  "例え.jp",
  "t.co",
  "www.",
  "xn--",
  "localhost",
  "192.168.0.1",
  ".com",
  ".com",
  ".jp",
  ".co.uk",
  ".example",
  ".c",
  ".みんな",
  ".",
  ".",
  "/",
  "/",
  "/",
  "?",
  "?q=",
  ":80",
  "(",
  ")",
  " ",
  " ",
  "%20",
  "%zz",
  "#tag",
  "@alice",
  "@example.com",
];

// Hosts for IDNA2003's ToASCII (SHR-7), which Mastodon asks of a URL's host
// and not of an `xmpp:` address's or a mention's.
const idnCases = [
  // A character Unicode 3.2 does not have, such as most emoji.
  "https://👍.com/",
  "https://👍.com",
  "see https://a👍b.example.com/x.",
  "https://☃.com/",
  "https://♥.example.com",
  "https://👍.example.com https://example.org",
  "https://👍.com/https://example.com/a",
  "https://example.com/https://👍.com/a",
  "xmpp:a@👍.com",
  "@alice@👍.com https://👍.com",
  "gemini://👍.com/x",
  "https://ẞ.com",
  "https://ꙮ.com/",
  "https://ǅ.com/ https://ȡ.com/",
  // Right-to-left hosts, and both directions in one label.
  "https://مثال.com/",
  "https://مثال.مصر/صفحة",
  "https://דוגמה.com",
  "https://abc.דוגמה.קום/x",
  "https://aמ.com",
  "https://מa.com",
  "https://מ1.com",
  "https://1מ.com",
  "https://מ1מ.com",
  "https://מ-מ.com",
  "https://م٣م.com",
  "https://م٣.com",
  "https://例מ.jp",
  "https://sub.مثال.example.com/a",
  "https://مثالa.example.com/a",
  "https://\u05d0\u0301.com",
  "https://\u0301\u05d0.com",
  // Other scripts.
  "https://例え.jp/",
  "https://한국.kr/x",
  "https://한.kr/x",
  "https://ᄀ\u0301ᅡ.kr/x",
  "https://ไทย.com",
  "https://ලංකා.com",
  "https://भारत.भारत",
  // Zero-width joiners and the soft hyphen, which nameprep takes out.
  "https://a\u200db.com/",
  "https://a\u200cb.com/",
  "https://\u200d.com/",
  "https://नम\u200dस्ते.com",
  "https://exam\u00adple.com/",
  "https://\u00ad.com/",
  "https://a.\u00ad.com",
  "https://a\u00ad\u1806\u180b\u2060\ufe0f.com",
  "https://例\u00ad.jp",
  // The dots IDNA separates labels at.
  "https://example。com/",
  "https://例え。jp/",
  "https://例え｡jp",
  "https://例え．jp/x",
  "https://例え.jp。",
  "https://sub．例え.jp/x",
  "https://ｅｘａｍｐｌｅ.com/",
  "https://example.ｃｏｍ/",
  // Upper case, folded by nameprep.
  "https://ÉCOLE.fr/",
  "https://ПРИМЕР.рф",
  "https://ПРИМЕР.РФ",
  "https://ΣΊΣΥΦΟΣ.gr",
  "HTTPS://ÄÖÜ.DE/X",
  "https://İstanbul.com",
  "https://STRASSE.de https://Straße.de https://STRAẞE.de",
  // ACE labels.
  "https://xn--例え.jp",
  "https://XN--例.jp",
  "https://ｘｎ--例.jp",
  "https://xn--a.com",
  "https://xn--.com",
  "https://xn--80akhbyknj4f.xn--p1ai/x",
  "https://例.xn--zckzah/x",
  "https://example.xn--例",
  // Characters Ruby's case-insensitive matching reads as two letters.
  "https://example.ﬁ",
  "https://example.ﬁ/x",
  "https://example.ﬁx",
  "https://example.ﬁﬁ",
  "https://exampleﬁ.ﬁ/",
  "https://ﬁ.ﬁ",
  "https://example.swiß/x",
  "https://example.SWIẞ",
  "https://example.swiẞ/https://example.com",
  "https://example.oﬃce",
  "https://example.oﬀice",
  "https://example.ofﬁce",
  "https://example.ﬀ",
  "https://example.ſwiss",
  "https://example.buſineſs",
  "https://example.ſt https://example.ﬅ https://example.ﬆ",
  "xmpp:a@example.ﬁ",
  "@alice@example.ﬁ",
  "ßb://example.com/x",
  "ẞb://example.com",
  "sſb://example.com",
  "ipfſ://example.com",
  "HTTPſ://example.com",
  "https://t.co/aßb",
];

// Labels near 63 octets, as written and in punycode.
for (const unit of ["a", "é", "例", "ß", "aé", "\u00ad", "ｘ"]) {
  for (let length = 1; length <= 66; length += unit === "a" || unit === "\u00ad" ? 31 : 1) {
    idnCases.push(`https://${unit.repeat(length)}.com/`);
  }
}
idnCases.push(
  `https://${"a".repeat(63)}.com`,
  `https://${"a".repeat(64)}.com`,
  `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com/x`,
  `https://${"\u00ad".repeat(300)}é.com/`,
  `https://é${"\u200d".repeat(300)}.com/`,
);

// twitter-text's 4096 characters, counted in code points, with what
// punycode adds to the host (`例え` is 9 longer as `xn--r8jz45g`).
for (const [start, unit, most] of [
  ["https://例え.jp/", "a", 4087],
  ["https://例え.jp/", "👍", 4087],
  ["https://example.com/", "👍", 4096],
  ["https://exam\u00adple.com/", "a", 4096],
  ["https://ｅｘａｍｐｌｅ.com/", "a", 4096],
]) {
  for (const length of [most, most + 1]) {
    idnCases.push(start + unit.repeat(length - Array.from(start).length));
  }
}

// Each top-level domain with letters Ruby also reads from one character
// (`ﬁ` for `fi`), spelled with it.
const coreRequire = createRequire(path("../packages/core/package.json"));
const lettersAsOne = [
  ["ffi", "ﬃ"],
  ["ffl", "ﬄ"],
  ["ff", "ﬀ"],
  ["fi", "ﬁ"],
  ["fl", "ﬂ"],
  ["ss", "ß"],
  ["ss", "ẞ"],
  ["st", "ﬅ"],
  ["st", "ﬆ"],
];
for (const list of ["validGTLD", "validCCTLD"]) {
  const module = coreRequire(`twitter-text/dist/regexp/${list}`);
  for (const tld of (module.default ?? module).source.match(/[a-z]{2,}/g)) {
    for (const [letters, character] of lettersAsOne) {
      for (let at = tld.indexOf(letters); at !== -1; at = tld.indexOf(letters, at + 1)) {
        const spelled = tld.slice(0, at) + character + tld.slice(at + letters.length);
        idnCases.push(`https://example.${spelled}/x`);
      }
      if (tld.includes(letters)) {
        idnCases.push(`https://例.${tld.replaceAll(letters, character).replace("ss", "ß")}`);
      }
    }
  }
}

const idnTokens = [
  ...Array.from("abZ19-_éÉßẞﬁﬆſİǅ例えم٣ثלד가가👍☃ａＢ𝐀㍿㎏ª²½ℂⅫ"),
  "\u200d",
  "\u200c",
  "\u00ad",
  "\u0301",
  "\u05b0",
  "\u3099",
  "xn--",
  "a",
  "a",
  "example",
];
const idnDots = [".", ".", ".", ".", "。", "．", "｡"];
const idnTlds = ["com", "com", "jp", "рф", "みんな", "مصر", "קום", "ﬁ", "swiß", "st", "COM", "c"];

// mulberry32, so the corpus is the same on every run.
let seed = 6;
const random = (n) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
const pick = (list) => list[random(list.length)];
const noise = (most) => Array.from({ length: random(most + 1) }, () => pick(tokens)).join("");
const starts = ["https://", "https://", "http://", "gemini://", "xmpp:", "magnet:?", ""];
const hosts = [
  "example.com",
  "example.com",
  "例え.jp",
  "sub.example.co.uk",
  "t.co",
  "a_b.example.org",
];
// Half are noise only; the others have a URL start, so that most of the
// corpus exercises a path, a query or what follows a host.
const generated = Array.from({ length: 6000 }, (_, index) =>
  index % 2 === 0
    ? noise(12)
    : `${noise(2)}${pick(starts)}${pick(hosts)}${pick(["", "", "/", "/", "?", ":80/"])}${noise(8)}`,
);

const idnLabel = () => Array.from({ length: 1 + random(4) }, () => pick(idnTokens)).join("");
const idnHost = () =>
  `${Array.from({ length: 1 + random(3) }, () => idnLabel() + pick(idnDots)).join("")}${pick(idnTlds)}`;
const idnHosts = Array.from({ length: 3000 }, idnHost);
const idnGenerated = idnHosts.map(
  (host) => `${noise(1)}${pick(starts)}${host}${pick(["", "", "/", "/x", "?", ":80/"])}${noise(3)}`,
);

const texts = [...new Set([...pinned, ...cases, ...idnCases, ...generated, ...idnGenerated])];
// The hosts above, and what a URL's host cannot be: no label, an empty one.
const domains = [
  ...new Set([
    ...idnCases.flatMap((text) => /^https:\/\/([^/ :?]+)/u.exec(text)?.[1] ?? []),
    ...idnHosts,
    "",
    ".",
    "。",
    "a.",
    ".a",
    "a..b",
    "a.b.",
    "a.b..",
    "é",
    "é.",
  ]),
];
const ruby = spawnSync("ruby", [path("./post-text-reference.rb")], {
  input: JSON.stringify({ texts, domains }),
  encoding: "utf8",
  maxBuffer: 2 ** 28,
  stdio: ["pipe", "pipe", "inherit"],
});
if (ruby.status !== 0) {
  throw new Error("scripts/post-text-reference.rb failed");
}
const results = JSON.parse(ruby.stdout);

// tstodon differs from Mastodon by design in two ways, and such a text is
// left out: a mention whose domain carries a port, which tstodon keeps, and
// a hashtag without a letter before `http://` (`#1http://`), which Mastodon
// links though no tag can have the name.
const byDesign = [
  /@[\w.-]+@[\p{L}\p{M}\p{Nd}\p{Pc}.-]+:\d/u,
  /[#＃][\p{M}\p{Nd}\p{Pc}]+https?:\/\//u,
];
const rows = texts.flatMap((text, index) =>
  byDesign.some((pattern) => pattern.test(text)) ? [] : [[text, ...results.texts[index]]],
);

const write = (file, list) =>
  writeFileSync(
    path(`../packages/core/src/${file}`),
    `[\n${list.map((row) => JSON.stringify(row)).join(",\n")}\n]\n`,
  );
write("post-text.fixture.json", rows);
write(
  "idna.fixture.json",
  domains.map((domain, index) => [domain, results.domains[index]]),
);
console.log(
  `wrote ${rows.length} texts (${texts.length - rows.length} left out) and ${domains.length} hosts (${results.domains.filter((ascii) => ascii === null).length} refused)`,
);
