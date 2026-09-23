import { describe, expect, it } from "vitest";
import {
  mastodonCustomEmojiDocument,
  mastodonInstanceRuleDocument,
  parseAnnouncements,
  parseCustomEmojis,
  parseInstanceRules,
} from "./instance-catalog";

const envWith = (vars: Record<string, string>): Env => vars as unknown as Env;

describe("instance catalog parsers", () => {
  it("parses JSON and newline INSTANCE_RULES", () => {
    const json = parseInstanceRules(
      envWith({
        INSTANCE_RULES: JSON.stringify([{ id: "a", text: "Be kind" }, "No spam"]),
      }),
    );
    expect(json.isOk()).toBe(true);
    if (json.isOk()) {
      expect(json.value.map(mastodonInstanceRuleDocument)).toEqual([
        { id: "a", text: "Be kind" },
        { id: "2", text: "No spam" },
      ]);
    }

    const lines = parseInstanceRules(envWith({ INSTANCE_RULES: "One\nTwo\n" }));
    expect(lines.isOk()).toBe(true);
    if (lines.isOk()) {
      expect(lines.value).toHaveLength(2);
      expect(lines.value[0]?.id).toBe("1");
    }

    expect(parseInstanceRules(envWith({})).unwrapOr([])).toEqual([]);
  });

  it("parses custom emoji catalog JSON", () => {
    const parsed = parseCustomEmojis(
      envWith({
        INSTANCE_CUSTOM_EMOJIS: JSON.stringify([
          {
            shortcode: "wave",
            url: "https://media.example.com/wave.png",
            visible_in_picker: true,
            category: "Gestures",
          },
        ]),
      }),
    );
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(mastodonCustomEmojiDocument(parsed.value[0]!)).toEqual({
        shortcode: "wave",
        url: "https://media.example.com/wave.png",
        static_url: "https://media.example.com/wave.png",
        visible_in_picker: true,
        category: "Gestures",
      });
    }
  });

  it("parses announcement catalog JSON", () => {
    const parsed = parseAnnouncements(
      envWith({
        INSTANCE_ANNOUNCEMENTS: JSON.stringify([
          {
            id: "welcome",
            content: "Hello local core",
            published_at: "2026-09-22T12:00:00.000Z",
          },
        ]),
      }),
    );
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value[0]?.id).toBe("welcome");
      expect(parsed.value[0]?.updatedAt).toBe("2026-09-22T12:00:00.000Z");
    }
  });

  it("rejects invalid emoji JSON", () => {
    expect(parseCustomEmojis(envWith({ INSTANCE_CUSTOM_EMOJIS: "{" })).isErr()).toBe(true);
  });
});
