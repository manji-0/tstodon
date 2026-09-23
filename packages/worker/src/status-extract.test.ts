import { describe, expect, it } from "vitest";
import { extractHashtags, extractHttpUrls } from "./status-store";

describe("status text extractors", () => {
  it("extracts unique lowercase hashtags", () => {
    expect(extractHashtags("Hello #WaveA and #wavea plus #Other")).toEqual(["wavea", "other"]);
  });

  it("extracts http(s) URLs and strips trailing punctuation", () => {
    expect(
      extractHttpUrls(
        "See https://example.com/path?q=1. and http://news.example/story! also https://example.com/path?q=1",
      ),
    ).toEqual(["https://example.com/path?q=1", "http://news.example/story"]);
  });
});
