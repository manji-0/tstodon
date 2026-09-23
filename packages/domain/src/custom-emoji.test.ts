import { describe, expect, it } from "vitest";
import { CustomEmoji } from "./custom-emoji";

describe("CustomEmoji", () => {
  it("parses a visible emoji with category", () => {
    const parsed = CustomEmoji.parse({
      kind: "CustomEmoji",
      shortcode: "blobcat",
      url: "https://media.example.com/emoji/blobcat.png",
      staticUrl: "https://media.example.com/emoji/blobcat-static.png",
      visibleInPicker: true,
      category: "Blobs",
    });
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value.shortcode).toBe("blobcat");
      expect(parsed.value.category).toBe("Blobs");
    }
  });

  it("rejects invalid shortcodes", () => {
    expect(
      CustomEmoji.parse({
        kind: "CustomEmoji",
        shortcode: "bad-code",
        url: "https://media.example.com/emoji.png",
        staticUrl: "https://media.example.com/emoji.png",
        visibleInPicker: true,
      }).isErr(),
    ).toBe(true);
  });
});
