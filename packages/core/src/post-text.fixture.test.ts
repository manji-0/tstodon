import { describe, expect, it } from "vite-plus/test";
import { countableText, extractEntities, statusLength } from "./post-text";
import { mastodonPostTexts } from "./post-text.fixture";

describe("post text against Mastodon's server", () => {
  const rows = mastodonPostTexts();

  it("links what Mastodon links and counts what it counts, on its corpus of over 5,000 texts", () => {
    expect(rows.length).toBeGreaterThan(5000);
    const mismatches = rows.flatMap(([text, entities, countable, length]) => {
      const found = {
        entities: extractEntities(text).map((entity) => [
          entity.kind.slice(0, 1),
          entity.start,
          entity.end,
        ]),
        countable: countableText(text),
        length: statusLength("", text),
      };
      return JSON.stringify(found) === JSON.stringify({ entities, countable, length })
        ? []
        : [{ text, found, mastodon: { entities, countable, length } }];
    });
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(mismatches).toHaveLength(0);
  });
});
