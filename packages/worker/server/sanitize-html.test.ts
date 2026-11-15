import { describe, expect, it } from "vite-plus/test";
import { type FailedTagScans, httpUrl, sanitizeRemoteHtml, tagAt } from "./sanitize-html";

describe("sanitizeRemoteHtml", () => {
  it("keeps Mastodon's own markup", () => {
    const html =
      '<p>Hi <span class="h-card" translate="no"><a href="https://a.example/@bob" class="u-url mention">@<span>bob</span></a></span> ' +
      '<a href="https://a.example/tags/x" class="mention hashtag" rel="tag">#<span>x</span></a><br>' +
      '<a href="https://example.com/long" rel="nofollow noopener" target="_blank"><span class="invisible">https://</span><span class="ellipsis">example.com/lo</span><span class="invisible">ng</span></a></p>';
    expect(sanitizeRemoteHtml(html)).toBe(
      '<p>Hi <span class="h-card" translate="no"><a href="https://a.example/@bob" class="u-url mention" rel="nofollow noopener" target="_blank">@<span>bob</span></a></span> ' +
        '<a href="https://a.example/tags/x" class="mention hashtag" rel="nofollow noopener" target="_blank">#<span>x</span></a><br>' +
        '<a href="https://example.com/long" rel="nofollow noopener" target="_blank"><span class="invisible">https://</span><span class="ellipsis">example.com/lo</span><span class="invisible">ng</span></a></p>',
    );
  });

  it("keeps text and entities as written", () => {
    expect(sanitizeRemoteHtml("<p>1 &lt; 2 &amp;&amp; it&#8217;s fine & 3 > 2</p>")).toBe(
      "<p>1 &lt; 2 &amp;&amp; it&#8217;s fine &amp; 3 &gt; 2</p>",
    );
  });

  it.each([
    ["<p>a<script>alert(1)</script>b</p>", "<p>ab</p>"],
    ["<p>a<SCRIPT src=x></SCRIPT >b</p>", "<p>ab</p>"],
    ["<style>p{display:none}</style><p>x</p>", "<p>x</p>"],
    ['<img src=x onerror="alert(1)">', ""],
    ['<p onclick="alert(1)" style="color:red">x</p>', "<p>x</p>"],
    ['<a href="javascript:alert(1)">x</a>', '<a rel="nofollow noopener" target="_blank">x</a>'],
    [
      '<a href="jav&#x61;script&colon;alert(1)">x</a>',
      '<a rel="nofollow noopener" target="_blank">x</a>',
    ],
    ['<a href=" JAVASCRIPT:alert(1)">x</a>', '<a rel="nofollow noopener" target="_blank">x</a>'],
    ['<a href="data:text/html,<script>">x</a>', '<a rel="nofollow noopener" target="_blank">x</a>'],
    ['<iframe src="https://evil.example"></iframe>ok', "ok"],
    ["<svg><script>alert(1)</script></svg>ok", "ok"],
    ["<!-- <script>alert(1)</script> -->ok", "ok"],
    ["<p>unclosed <b>bold", "<p>unclosed <b>bold</b></p>"],
    ["stray</p></div>", "stray"],
    ['<div class="mention evil">x</div>', "x"],
    ['<span class="mention evil">x</span>', '<span class="mention">x</span>'],
    [
      '<a title="a>b" href="https://ok.example">x</a>',
      '<a href="https://ok.example" rel="nofollow noopener" target="_blank">x</a>',
    ],
    [
      '<a href="https://ok.example/?a=1&amp;b=&quot;2">x</a>',
      '<a href="https://ok.example/?a=1&amp;b=&quot;2" rel="nofollow noopener" target="_blank">x</a>',
    ],
    ["< not a tag <3", "&lt; not a tag &lt;3"],
    ["<p<img src=x onerror=alert(1)>", "&lt;p"],
  ])("neutralises %s", (input, expected) => {
    expect(sanitizeRemoteHtml(input)).toBe(expected);
  });
});

describe("tagAt", () => {
  // The expression the scan replaces: one match attempt per `<`.
  const TAG =
    /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/;
  const alphabet = [
    "<",
    "<",
    ">",
    "/",
    "=",
    '"',
    "'",
    " ",
    " ",
    "\n",
    "\u00a0",
    "a",
    "b",
    "-",
    "1",
    "&",
    "!",
  ];
  let seed = 20261115;
  const random = (below: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * below);
  };

  it("finds the tags the one expression finds, on 30,000 random texts", () => {
    for (let round = 0; round < 30_000; round += 1) {
      const html = Array.from(
        { length: 1 + random(40) },
        () => alphabet[random(alphabet.length)],
      ).join("");
      const failed: FailedTagScans = { places: undefined };
      for (let at = html.indexOf("<"); at !== -1; at = html.indexOf("<", at + 1)) {
        const expected = TAG.exec(html.slice(at));
        expect(tagAt(html, at, failed), JSON.stringify([html, at])).toEqual(
          expected
            ? {
                end: at + expected[0].length,
                closing: expected[1] === "/",
                name: expected[2],
                attributes: expected[3],
              }
            : undefined,
        );
      }
    }
  });
});

describe("sanitizeRemoteHtml on hostile input", () => {
  // The fastest of three runs, against well-formed markup as long, so a
  // loaded machine slows both alike.
  const fastest = (html: string): number => {
    sanitizeRemoteHtml(html.slice(0, 200));
    return Math.min(
      ...[0, 1, 2].map(() => {
        const started = performance.now();
        sanitizeRemoteHtml(html);
        return performance.now() - started;
      }),
    );
  };

  it.each([
    ["tags that never close", "<a ".repeat(40_000)],
    ["tags that fail on a quote at the end", `${"<a ".repeat(40_000)}">`],
    ["attributes inside a quote that never closes", `<a x="${"<b y=".repeat(30_000)}`],
    ["attributes with no value", "<a x=".repeat(30_000)],
    ["closing tags that open nothing", `${"<b>".repeat(30_000)}${"</i>".repeat(30_000)}`],
    ["ampersands", "&".repeat(120_000)],
    ["comments that never close", "<!-".repeat(40_000)],
    ["dropped elements that never close", "<script>".repeat(20_000)],
  ])("takes linear time on %s", (_name, hostile) => {
    const wellFormed = "<b>x</b>".repeat(Math.ceil(hostile.length / 8));
    expect(fastest(hostile)).toBeLessThan(5 * fastest(wellFormed) + 20);
  });
});

describe("httpUrl", () => {
  it("accepts only http and https", () => {
    expect(httpUrl("https://a.example/x")).toBe("https://a.example/x");
    expect(httpUrl("http://a.example/x")).toBe("http://a.example/x");
    expect(httpUrl("javascript:alert(1)")).toBeUndefined();
    expect(httpUrl("data:text/html,x")).toBeUndefined();
    expect(httpUrl("not a url")).toBeUndefined();
    expect(httpUrl(undefined)).toBeUndefined();
  });
});
