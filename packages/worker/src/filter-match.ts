import { err, ok, type Result } from "neverthrow";
import type { LocalStatus } from "@tstodon/domain";
import type { RepositoryError } from "./d1";
import { mastodonFilterV2 } from "./mastodon";
import { FilterContextSchema, parseJsonColumn } from "./schemas";
import {
  filterKeywords,
  listFilterStatusIds,
  listFilters,
  type FilterRow,
} from "./moderation-store";

export type FilterWithStatuses = Readonly<{
  row: FilterRow;
  narrowedStatusIds: ReadonlyArray<string>;
}>;

export type FilterMatch = Readonly<{
  row: FilterRow;
  keywordMatches: ReadonlyArray<string>;
  statusMatches: ReadonlyArray<string>;
}>;

/** Every filter the viewer owns, with the statuses each is narrowed to. */
export const loadViewerFilters = async (
  db: D1Database,
  accountId: string,
): Promise<Result<ReadonlyArray<FilterWithStatuses>, RepositoryError>> => {
  const rows = await listFilters(db, accountId);
  if (rows.isErr()) {
    return err(rows.error);
  }
  const filters: FilterWithStatuses[] = [];
  for (const row of rows.value) {
    const statusIds = await listFilterStatusIds(db, row.id);
    if (statusIds.isErr()) {
      return err(statusIds.error);
    }
    filters.push({ row, narrowedStatusIds: statusIds.value });
  }
  return ok(filters);
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const keywordHits = (keyword: string, wholeWord: boolean, text: string): boolean => {
  const lowered = text.toLowerCase();
  const needle = keyword.toLowerCase();
  if (!wholeWord) {
    return lowered.includes(needle);
  }
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(needle)}(?:$|[^\\p{L}\\p{N}_])`,
    "iu",
  ).test(text);
};

/**
 * Filters matching a context (Mastodon's `home`/`notifications`/`public`/...):
 * a filter matches when one of its keywords appears in `text` or when it is
 * narrowed to this status. Expired filters are ignored.
 */
export const matchFilters = (
  filters: ReadonlyArray<FilterWithStatuses>,
  context: string,
  text: string,
  statusId: string | null,
): ReadonlyArray<FilterMatch> => {
  const now = Date.now();
  const matches: FilterMatch[] = [];
  for (const filter of filters) {
    const expiresAt = filter.row.expires_at;
    if (expiresAt !== null && Date.parse(expiresAt) <= now) {
      continue;
    }
    const contexts = parseJsonColumn(FilterContextSchema, filter.row.context_json);
    if (!contexts.isOk() || !contexts.value.includes(context)) {
      continue;
    }
    const statusMatches =
      statusId !== null && filter.narrowedStatusIds.includes(statusId) ? [statusId] : [];
    const keywordMatches = filterKeywords(filter.row)
      .filter((keyword) => keywordHits(keyword.keyword, keyword.whole_word, text))
      .map((keyword) => keyword.keyword);
    if (keywordMatches.length === 0 && statusMatches.length === 0) {
      continue;
    }
    matches.push({ row: filter.row, keywordMatches, statusMatches });
  }
  return matches;
};

/** The `filtered` array Mastodon attaches to statuses and notifications. */
export const filteredAttribute = (
  matches: ReadonlyArray<FilterMatch>,
  filterDocument: (row: FilterRow) => Record<string, unknown>,
): ReadonlyArray<Record<string, unknown>> =>
  matches.map((match) => ({
    filter: filterDocument(match.row),
    keyword_matches: [...match.keywordMatches],
    status_matches: [...match.statusMatches],
  }));

/**
 * Attach Mastodon's `filtered` attribute to already-rendered status documents.
 * Only local notes carry it: a reblog's text lives on another row, so its
 * document keeps `filtered` unset.
 */
export const attachFilteredToStatuses = async <T extends Record<string, unknown>>(
  db: D1Database,
  viewerId: string | undefined,
  context: string,
  statuses: ReadonlyArray<LocalStatus>,
  documents: ReadonlyArray<T>,
): Promise<ReadonlyArray<T>> => {
  if (!viewerId) {
    return documents;
  }
  const filters = await loadViewerFilters(db, viewerId);
  if (filters.isErr() || filters.value.length === 0) {
    return documents;
  }
  const texts = new Map<string, string>();
  for (const status of statuses) {
    if (status.kind === "LocalNote") {
      texts.set(status.id, status.text);
    }
  }
  return documents.map((document) => {
    const id = typeof document.id === "string" ? document.id : "";
    const text = texts.get(id);
    if (text === undefined) {
      return document;
    }
    const matches = matchFilters(filters.value, context, text, id);
    return matches.length > 0
      ? { ...document, filtered: filteredAttribute(matches, (row) => mastodonFilterV2(row)) }
      : document;
  });
};
