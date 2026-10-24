import { describe, expect, it } from "vite-plus/test";
import { httpUrl, sanitizeRemoteHtml } from "./sanitize-html";

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
