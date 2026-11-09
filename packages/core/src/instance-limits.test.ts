import { describe, expect, it } from "vite-plus/test";
import { InstanceLimits, countableLength, countableText } from "./instance-limits";

const reserved = InstanceLimits.status.charactersReservedPerUrl;

describe("countableText", () => {
  it("counts a URL as charactersReservedPerUrl, however long", () => {
    const long = `https://example.com/${"a".repeat(200)}?q=1`;
    expect(countableLength(long)).toBe(reserved);
    expect(countableLength("http://x.y")).toBe(reserved);
    expect(countableLength(`see ${long} now`)).toBe(4 + reserved + 4);
  });

  it("leaves trailing punctuation outside the URL", () => {
    expect(countableText("(https://example.com/a).")).toBe(`(${"x".repeat(reserved)}).`);
  });

  it("does not shorten a URL inside a word or a bare scheme", () => {
    expect(countableText("xhttps://example.com")).toBe("xhttps://example.com");
    expect(countableText("https://")).toBe("https://");
  });

  it("counts a remote mention without its domain", () => {
    expect(countableText("hi @alice@social.example.org!")).toBe("hi @alice!");
    expect(countableText("@bob")).toBe("@bob");
    expect(countableText("mail a@b.example")).toBe("mail a@b.example");
  });

  it("counts code points", () => {
    expect(countableLength("🐘🐘")).toBe(2);
  });
});
