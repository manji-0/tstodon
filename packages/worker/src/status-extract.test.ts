import { describe, expect, it } from "vite-plus/test";
import { extractHashtags } from "./hashtags";
import { htmlHashtags } from "./html";

describe("status text extractors", () => {
  it("extracts unique lowercase hashtags", () => {
    expect(extractHashtags("Hello #WaveA and #wavea plus #Other")).toEqual(["wavea", "other"]);
  });

  it("leaves out a `#` inside a word, a URL or after `=`, as Mastodon's HASHTAG_RE", () => {
    expect(
      extractHashtags(
        "https://app.example/invite#Kq8sZ2pX word#token a/#path x=#query (#kept) #real",
      ),
    ).toEqual(["kept", "real"]);
  });

  it("reads a remote note's hashtags from its text, not from link targets", () => {
    const url = "https://app.example/invite#Kq8sZ2pX";
    expect(
      htmlHashtags(
        `<p><a href="${url}">${url}</a> <a href="https://app.example/#Hidden">link</a> ` +
          `<a class="mention hashtag" rel="tag" href="https://remote.example/tags/real">#<span>Real</span></a> #plain</p>`,
      ),
    ).toEqual(["real", "plain"]);
  });
});
