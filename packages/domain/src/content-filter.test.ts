import { describe, expect, it } from "vite-plus/test";
import { ContentFilter } from "./content-filter";

const NOW = Date.parse("2026-11-04T00:00:00.000Z");

const filter = {
  contexts: ["home", "public"],
  expiresAt: null,
  keywords: [
    { keyword: "Spoiler", wholeWord: false },
    { keyword: "cat", wholeWord: true },
  ],
  statusIds: ["s1"],
} as const satisfies ContentFilter;

const home = (text: string, statusId: string | null = null) =>
  ({ context: "home", text, statusId }) as const;

describe("ContentFilter.match", () => {
  it("matches a keyword anywhere, ignoring case", () => {
    expect(ContentFilter.match(filter, home("big SPOILERS ahead"), NOW)).toEqual({
      keywordMatches: ["Spoiler"],
      statusMatches: [],
    });
  });

  it("matches a whole-word keyword only between word boundaries", () => {
    expect(ContentFilter.match(filter, home("my Cat, again"), NOW)?.keywordMatches).toEqual([
      "cat",
    ]);
    expect(ContentFilter.match(filter, home("concatenate"), NOW)).toBeUndefined();
    expect(ContentFilter.match(filter, home("ねこcat"), NOW)).toBeUndefined();
  });

  it("matches the statuses it is narrowed to", () => {
    expect(ContentFilter.match(filter, home("nothing here", "s1"), NOW)).toEqual({
      keywordMatches: [],
      statusMatches: ["s1"],
    });
  });

  it("ignores other contexts and expired filters", () => {
    expect(
      ContentFilter.match(
        filter,
        { context: "notifications", text: "spoiler", statusId: null },
        NOW,
      ),
    ).toBeUndefined();
    expect(
      ContentFilter.match(
        { ...filter, expiresAt: "2026-11-04T00:00:00.000Z" },
        home("spoiler"),
        NOW,
      ),
    ).toBeUndefined();
    expect(
      ContentFilter.match(
        { ...filter, expiresAt: "2026-11-05T00:00:00.000Z" },
        home("spoiler"),
        NOW,
      ),
    ).toBeDefined();
  });
});
