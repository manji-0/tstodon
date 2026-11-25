import { describe, expect, it } from "vite-plus/test";
import { StatusSearchQuery } from "./status-search-query";

const parsed = (query: string) => StatusSearchQuery.parse(query)._unsafeUnwrap();

const DAY = Date.UTC(2024, 0, 15);

// Each case is what Mastodon v4.7.5's `SearchQueryParser` and
// `SearchQueryTransformer` make of the query.
describe("StatusSearchQuery.parse", () => {
  it("reads words, tags, phrases and their operators", () => {
    expect(parsed('cat +dog -fish #Tea "big red" -"bad word"')).toEqual({
      scope: "All",
      clauses: [
        { kind: "Words", occurrence: "Must", words: ["cat"] },
        { kind: "Words", occurrence: "Must", words: ["dog"] },
        { kind: "Words", occurrence: "MustNot", words: ["fish"] },
        { kind: "Tag", occurrence: "Must", name: "Tea" },
        { kind: "Phrase", occurrence: "Must", words: ["big", "red"] },
        { kind: "Phrase", occurrence: "MustNot", words: ["bad", "word"] },
      ],
    });
  });

  it("reads the supported prefixes, case-insensitively, and an unknown one as words", () => {
    expect(
      parsed("HAS:media -is:reply language:EN-us from:@alice@example.com from:me foo:bar").clauses,
    ).toEqual([
      { kind: "Property", negated: false, property: "media" },
      { kind: "Property", negated: true, property: "reply" },
      { kind: "Language", negated: false, code: "en" },
      {
        kind: "From",
        negated: false,
        author: { kind: "Handle", username: "alice", domain: "example.com" },
      },
      { kind: "From", negated: false, author: { kind: "Viewer" } },
      { kind: "Words", occurrence: "Must", words: ["foo", "bar"] },
    ]);
  });

  it("reads dates as Elasticsearch fills a day's missing time", () => {
    expect(parsed("before:2024-01-15 after:2024-01-15 during:2024-01-15").clauses).toEqual([
      { kind: "Created", negated: false, range: { until: DAY } },
      { kind: "Created", negated: false, range: { from: DAY + 86_400_000 } },
      { kind: "Created", negated: false, range: { from: DAY, until: DAY + 86_400_000 } },
    ]);
    expect(parsed(`after:${DAY}`).clauses).toEqual([
      { kind: "Created", negated: false, range: { from: DAY + 1 } },
    ]);
    expect(StatusSearchQuery.parse("before:2024-13-45").isErr()).toBe(true);
    expect(StatusSearchQuery.parse("during:yesterday").isErr()).toBe(true);
  });

  it("keeps the last `in:` as the scope", () => {
    expect(parsed("in:public cat in:library")).toEqual({
      scope: "Library",
      clauses: [{ kind: "Words", occurrence: "Must", words: ["cat"] }],
    });
    expect(parsed("in:everything cat").scope).toBe("All");
  });

  it("drops a stray quote, reads a lone prefix as a word, and fails as Parslet does", () => {
    expect(parsed('cat "dog').clauses).toEqual([
      { kind: "Words", occurrence: "Must", words: ["cat"] },
      { kind: "Words", occurrence: "Must", words: ["dog"] },
    ]);
    expect(parsed("foo: bar").clauses).toEqual([
      { kind: "Words", occurrence: "Must", words: ["foo"] },
      { kind: "Words", occurrence: "Must", words: ["bar"] },
    ]);
    expect(parsed("“quoted words”").clauses).toEqual([
      { kind: "Phrase", occurrence: "Must", words: ["quoted", "words"] },
    ]);
    expect(StatusSearchQuery.parse("cat :").isErr()).toBe(true);
    expect(StatusSearchQuery.parse("- cat").isErr()).toBe(true);
  });
});
