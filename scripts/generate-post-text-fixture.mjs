#!/usr/bin/env node
// Writes packages/core/src/post-text.fixture.json: what Mastodon's server
// finds in a corpus of post texts, for packages/core/src/post-text.fixture.test.ts
// to hold `@tstodon/core/post-text` to. Run once per Mastodon release; the
// test needs no Ruby. It runs scripts/post-text-reference.rb, which says
// what it needs:
//
//   MASTODON_SRC=../mastodon node scripts/generate-post-text-fixture.mjs
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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

const texts = [...new Set([...pinned, ...cases, ...generated])];
const ruby = spawnSync("ruby", [path("./post-text-reference.rb")], {
  input: JSON.stringify(texts),
  encoding: "utf8",
  maxBuffer: 2 ** 28,
  stdio: ["pipe", "pipe", "inherit"],
});
if (ruby.status !== 0) {
  throw new Error("scripts/post-text-reference.rb failed");
}
const results = JSON.parse(ruby.stdout);

// tstodon differs from Mastodon by design in three ways, and such a text is
// left out: a host libidn refuses (the reference prints `null`), a mention
// whose domain carries a port, which tstodon keeps, and a hashtag without a
// letter before `http://` (`#1http://`), which Mastodon links though no tag
// can have the name.
const byDesign = [
  /@[\w.-]+@[\p{L}\p{M}\p{Nd}\p{Pc}.-]+:\d/u,
  /[#＃][\p{M}\p{Nd}\p{Pc}]+https?:\/\//u,
];
const rows = texts.flatMap((text, index) => {
  const result = results[index];
  return result === null || byDesign.some((pattern) => pattern.test(text))
    ? []
    : [[text, ...result]];
});

writeFileSync(
  path("../packages/core/src/post-text.fixture.json"),
  `[\n${rows.map((row) => JSON.stringify(row)).join(",\n")}\n]\n`,
);
console.log(
  `wrote ${rows.length} texts (${texts.length - rows.length} left out: ${results.filter((result) => result === null).length} for libidn)`,
);
