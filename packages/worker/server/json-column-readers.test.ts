import { describe, expect, it } from "vite-plus/test";
import { filterKeywords, type FilterRow } from "./filter-store";
import { parseCardJson } from "./link-card";

const filterRow = (keywordsJson: string): FilterRow => ({
  id: "filter-1",
  account_id: "account-1",
  phrase: "spoiler",
  context_json: "[]",
  whole_word: 1,
  irreversible: 0,
  expires_at: null,
  keywords_json: keywordsJson,
});

describe("JSON column readers", () => {
  it("read a corrupt filter keyword column as the v1 phrase", () => {
    expect(filterKeywords(filterRow("[{"))).toEqual([
      { id: "filter-1", keyword: "spoiler", whole_word: true },
    ]);
  });

  it("read a corrupt link card column as no card", () => {
    expect(parseCardJson("{not json")).toBeUndefined();
  });
});
