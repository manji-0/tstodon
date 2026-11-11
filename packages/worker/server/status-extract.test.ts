import { describe, expect, it } from "vite-plus/test";
import { extractHashtags } from "@tstodon/core";
import { htmlHashtags } from "./hashtags";

describe("status text extractors", () => {
  it("extracts unique lowercase hashtags", () => {
    expect(extractHashtags("Hello #WaveA and #wavea plus #Other")).toEqual(["wavea", "other"]);
  });

  it("takes a `#` only at a line start or after a space, as Mastodon's HASHTAG_RE", () => {
    expect(
      extractHashtags(
        "https://app.example/invite#Kq8sZ2pX word#token a/#path x=#query (#paren) #real\n#line",
      ),
    ).toEqual(["real", "line"]);
  });

  it("reads a remote note's hashtags from its text, not from link targets", () => {
    const url = "https://app.example/invite#Kq8sZ2pX";
    expect(
      htmlHashtags(
        `<p><a href="${url}">${url}</a> <a href="https://app.example/#Hidden">link</a> ` +
          `<a class="mention hashtag" rel="tag" href="https://remote.example/tags/real">#<span>Real</span></a> #plain</p>`,
      ),
    ).toEqual(["real", "plain"]);
    // Mastodon splits a long link's text across spans, here right at the `#`.
    expect(
      htmlHashtags(
        `<p><a href="${url}"><span class="invisible">https://</span><span class="ellipsis">app.example/invite</span>` +
          `<span class="invisible">#Kq8sZ2pX</span></a></p>`,
      ),
    ).toEqual([]);
  });

  it("needs a letter in a tag and reads no tag from an HTML entity, as Mastodon", () => {
    expect(extractHashtags("#123 #2024 #a1 #1a #_x")).toEqual(["a1", "1a", "_x"]);
    expect(htmlHashtags("<p>it&#8217;s &#x27;quoted&#x27; &#8220;x&#8221; #ok</p>")).toEqual([
      "ok",
    ]);
  });
});
