import { FilterContextSchema, parseJsonColumn } from "./schemas";
import { filterKeywords, type FilterRow, type FilterStatus } from "./moderation-store";

export const mastodonFilter = (row: FilterRow): Record<string, unknown> => {
  const context = parseJsonColumn(FilterContextSchema, row.context_json);
  const contexts = context.isOk() ? context.value : ["home"];
  return {
    id: row.id,
    phrase: row.phrase,
    context: contexts,
    whole_word: row.whole_word === 1,
    irreversible: row.irreversible === 1,
    expires_at: row.expires_at,
  };
};

/** Mastodon's v2 Filter; `statuses` are FilterStatus entities (`{ id, status_id }`). */
export const mastodonFilterV2 = (
  row: FilterRow,
  statuses: ReadonlyArray<FilterStatus> = [],
): Record<string, unknown> => {
  const v1 = mastodonFilter(row);
  return {
    id: row.id,
    title: row.phrase,
    context: v1.context,
    expires_at: row.expires_at,
    filter_action: row.irreversible === 1 ? "hide" : "warn",
    statuses: statuses.map((entry) => ({ id: entry.id, status_id: entry.status_id })),
    keywords: filterKeywords(row).map((keyword) => ({
      id: keyword.id,
      keyword: keyword.keyword,
      whole_word: keyword.whole_word,
    })),
  };
};
