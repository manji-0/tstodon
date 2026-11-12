import { describe, expect, it } from "vite-plus/test";
import { InstanceIdentity } from "@tstodon/domain";
import { escapeHtml, formatPostText, htmlToText, mentionUsernames, textToHtml } from "./html";

describe("html helpers", () => {
  it("escapes HTML special characters", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });

  it("wraps escaped text and converts newlines", () => {
    expect(textToHtml("hi\n<script>")).toBe("<p>hi<br>&lt;script&gt;</p>");
  });

  it("collects unique lowercase mention usernames", () => {
    expect(mentionUsernames("Hello @Alice and @bob_01 and @Alice again", "example.com")).toEqual([
      "alice",
      "bob_01",
    ]);
    expect(mentionUsernames("no mentions here", "example.com")).toEqual([]);
  });
});

describe("formatPostText", () => {
  const parsed = InstanceIdentity.parse({
    kind: "InstanceIdentity",
    domain: "example.com",
    publicOrigin: "https://example.com",
    name: "tstodon",
    description: "test",
    sourceUrl: "https://github.com/example/tstodon",
    languages: ["en"],
    contactEmail: "admin@example.com",
    thumbnailUrl: "https://example.com/thumbnail.png",
    mediaPublicBaseUrl: "https://media.example.com/",
  });
  if (parsed.isErr()) {
    throw new Error("invalid identity");
  }
  const identity = parsed.value;
  const format = (text: string, mentions: Parameters<typeof formatPostText>[1]["mentions"] = []) =>
    formatPostText(text, { identity, mentions });
  const link = (href: string, prefix: string, shown: string, hidden: string) =>
    `<a href="${href}" target="_blank" rel="nofollow noopener" translate="no"><span class="invisible">${prefix}</span><span class="${hidden.length > 0 ? "ellipsis" : ""}">${shown}</span><span class="invisible">${hidden}</span></a>`;

  it("links a mention written with another domain than the actor's canonical one", () => {
    const url = "https://example.net/users/alice";
    expect(
      format("hi @alice@social.example.net", [
        { username: "alice", domain: "example.net", url },
        { username: "alice", domain: "social.example.net", url },
      ]),
    ).toBe(
      `<p>hi <span class="h-card" translate="no"><a href="${url}" class="u-url mention">@<span>alice</span></a></span></p>`,
    );
  });

  it("reads back as the text it was written from", () => {
    expect(
      htmlToText(
        format(
          "hey @alice see #tag https://www.example.com/a/very/long/path/that/goes/beyond/thirty\n\nnext",
          [{ username: "alice", domain: null, url: "https://example.com/users/alice" }],
        ),
      ),
    ).toBe(
      "hey @alice see #tag https://www.example.com/a/very/long/path/that/goes/beyond/thirty next",
    );
  });

  it("makes paragraphs and line breaks as Rails' simple_format", () => {
    expect(format("a\nb\n\n\nc\n")).toBe("<p>a<br />b</p><p>c</p>");
    expect(format("\n\na\r\nb")).toBe("<p></p><p>a<br />b</p>");
    expect(format(" \n ")).toBe("");
  });

  it("escapes the text between and inside links", () => {
    expect(format(`<i>"&" #a<b https://example.com/?a=1&b=2">`)).toBe(
      `<p>&lt;i&gt;&quot;&amp;&quot; <a href="https://example.com/tags/a" class="mention hashtag" rel="tag">#<span>a</span></a>&lt;b ${link("https://example.com/?a=1&amp;b=2", "https://", "example.com/?a=1&amp;b=2", "")}&quot;&gt;</p>`,
    );
  });

  it("hides a URL's scheme and what is past 30 characters, unless that is one character", () => {
    const path = (length: number) => `example.com/${"a".repeat(length - 12)}`;
    expect(format(`http://www.${path(30)}`)).toBe(
      `<p>${link(`http://www.${path(30)}`, "http://www.", path(30), "")}</p>`,
    );
    expect(format(`https://${path(31)}`)).toBe(
      `<p>${link(`https://${path(31)}`, "https://", path(31), "")}</p>`,
    );
    expect(format(`https://${path(32)}`)).toBe(
      `<p>${link(`https://${path(32)}`, "https://", path(30), "aa")}</p>`,
    );
  });

  it("links the URLs Mastodon's server finds: any path character, its other schemes, xmpp: and magnet:", () => {
    expect(format("https://例え.jp/パス!")).toBe(
      `<p>${link("https://例え.jp/パス", "https://", "例え.jp/パス", "")}!</p>`,
    );
    expect(format("gemini://example.com/a/long/capsule/path ftp://example.com")).toBe(
      `<p>${link("gemini://example.com/a/long/capsule/path", "", "gemini://example.com/a/long/ca", "psule/path")} ftp://example.com</p>`,
    );
    expect(format("(xmpp:alice@example.com) magnet:?xt=urn:btih:abc&dn=a.")).toBe(
      `<p>(${link("xmpp:alice@example.com", "xmpp:", "alice@example.com", "")}) ${link("magnet:?xt=urn:btih:abc&amp;dn=a", "", "magnet:?xt=urn:btih:abc&amp;dn=a", "")}.</p>`,
    );
    expect(format("example.com/https://example.org")).toBe(
      "<p>example.com/https://example.org</p>",
    );
  });

  it("links a hashtag as written to its normalized name's page", () => {
    expect(format("＃ＣＡＴ #日本語")).toBe(
      `<p><a href="https://example.com/tags/cat" class="mention hashtag" rel="tag">#<span>ＣＡＴ</span></a> <a href="https://example.com/tags/${encodeURIComponent("日本語")}" class="mention hashtag" rel="tag">#<span>日本語</span></a></p>`,
    );
  });

  it("links only the mentions that resolved, by username and domain", () => {
    const card = (url: string, shown: string) =>
      `<span class="h-card" translate="no"><a href="${url}" class="u-url mention">@<span>${shown}</span></a></span>`;
    const local = { username: "bob", domain: null, url: "https://example.com/users/bob" };
    const remote = { username: "Bob", domain: "remote.example", url: "https://remote.example/u/1" };
    expect(format("@BOB @bob@Example.com @bob@remote.example @bob@other.example", [local])).toBe(
      `<p>${card(local.url, "bob")} ${card(local.url, "bob")} @bob@remote.example @bob@other.example</p>`,
    );
    expect(format("@bob @bob@REMOTE.example.", [local, remote])).toBe(
      `<p>${card(local.url, "bob")} ${card(remote.url, "Bob@remote.example")}.</p>`,
    );
    expect(format("@bob", [remote])).toBe("<p>@bob</p>");
  });
});
