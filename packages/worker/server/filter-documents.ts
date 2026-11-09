import { type ApiFilterJSON, type ApiV1FilterJSON, isFilterContext } from "@tstodon/api";
import { FilterContextSchema } from "./filter-store";
import { parseJsonColumn } from "./json-column";
import { filterKeywords, type FilterRow, type FilterStatus } from "./filter-store";

/** A filter's contexts; a stored value Mastodon does not name is left out. */
const filterContexts = (row: FilterRow): ApiFilterJSON["context"] => {
  const context = parseJsonColumn(FilterContextSchema, row.context_json);
  return context.isOk() ? context.value.filter(isFilterContext) : ["home"];
};

export const mastodonFilter = (row: FilterRow): ApiV1FilterJSON => ({
  id: row.id,
  phrase: row.phrase,
  context: filterContexts(row),
  whole_word: row.whole_word === 1,
  irreversible: row.irreversible === 1,
  expires_at: row.expires_at,
});

/** Mastodon's v2 Filter; `statuses` are FilterStatus entities (`{ id, status_id }`). */
export const mastodonFilterV2 = (
  row: FilterRow,
  statuses: ReadonlyArray<FilterStatus> = [],
): ApiFilterJSON => ({
  id: row.id,
  title: row.phrase,
  context: filterContexts(row),
  expires_at: row.expires_at,
  filter_action: row.irreversible === 1 ? "hide" : "warn",
  statuses: statuses.map((entry) => ({ id: entry.id, status_id: entry.status_id })),
  keywords: filterKeywords(row).map((keyword) => ({
    id: keyword.id,
    keyword: keyword.keyword,
    whole_word: keyword.whole_word,
  })),
});
