import type { ApiFilterResultJSON } from "@tstodon/api";
import { err, ok, type Result } from "neverthrow";
import { ContentFilter, LocalStatus } from "@tstodon/domain";
import type { RepositoryError } from "./d1";
import { htmlToText } from "./html";
import { mastodonFilterV2 } from "./filter-documents";
import { FilterContextSchema } from "./filter-store";
import { parseJsonColumn } from "./json-column";
import {
  filterKeywords,
  type FilterRow,
  type FilterStatus,
  listFilters,
  listFilterStatuses,
} from "./filter-store";

export type FilterWithStatuses = Readonly<{
  row: FilterRow;
  statuses: ReadonlyArray<FilterStatus>;
  filter: ContentFilter;
}>;

export type FilterMatch = Readonly<{
  row: FilterRow;
  statuses: ReadonlyArray<FilterStatus>;
  keywordMatches: ReadonlyArray<string>;
  statusMatches: ReadonlyArray<string>;
}>;

/** A row and its statuses as `ContentFilter`; unreadable contexts apply nowhere. */
const contentFilter = (row: FilterRow, statuses: ReadonlyArray<FilterStatus>): ContentFilter => {
  const contexts = parseJsonColumn(FilterContextSchema, row.context_json);
  return {
    contexts: contexts.isOk() ? contexts.value : [],
    expiresAt: row.expires_at,
    keywords: filterKeywords(row).map((keyword) => ({
      keyword: keyword.keyword,
      wholeWord: keyword.whole_word,
    })),
    statusIds: statuses.map((status) => status.status_id),
  };
};

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
    const statuses = await listFilterStatuses(db, row.id);
    if (statuses.isErr()) {
      return err(statuses.error);
    }
    filters.push({ row, statuses: statuses.value, filter: contentFilter(row, statuses.value) });
  }
  return ok(filters);
};

/**
 * Filters matching a context (Mastodon's `home`/`notifications`/`public`/...);
 * `ContentFilter.match` decides each.
 */
export const matchFilters = (
  filters: ReadonlyArray<FilterWithStatuses>,
  context: string,
  text: string,
  statusId: string | null,
): ReadonlyArray<FilterMatch> => {
  const now = Date.now();
  return filters.flatMap(({ row, statuses, filter }) => {
    const match = ContentFilter.match(filter, { context, text, statusId }, now);
    return match ? [{ row, statuses, ...match }] : [];
  });
};

/** A rendered status that can carry `filtered`. */
type FilterableDocument = Readonly<{ id: string; filtered?: ApiFilterResultJSON[] | undefined }>;

/** The `filtered` array Mastodon attaches to statuses and notifications. */
export const filteredAttribute = (matches: ReadonlyArray<FilterMatch>): ApiFilterResultJSON[] =>
  matches.map((match) => ({
    filter: mastodonFilterV2(match.row, match.statuses),
    keyword_matches: [...match.keywordMatches],
    status_matches: [...match.statusMatches],
  }));

/**
 * Attach Mastodon's `filtered` attribute to already-rendered status documents.
 * Only local notes carry it: a reblog's text lives on another row, so its
 * document keeps `filtered` unset.
 */
export const attachFilteredToStatuses = async <T extends FilterableDocument>(
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
  const texts = new Map<string, string>(
    statuses.filter(LocalStatus.isNote).map((note) => [note.id, note.text]),
  );
  return documents.map((document) => {
    const id = document.id;
    const text = texts.get(id);
    if (text === undefined) {
      return document;
    }
    const matches = matchFilters(filters.value, context, text, id);
    return matches.length > 0 ? { ...document, filtered: filteredAttribute(matches) } : document;
  });
};

/**
 * The same `filtered` attribute for remote status documents, matched against
 * the text of their stored HTML.
 */
export const attachFilteredToRemoteStatuses = async <T extends FilterableDocument>(
  db: D1Database,
  viewerId: string | undefined,
  context: string,
  statuses: ReadonlyArray<Readonly<{ id: string; contentHtml: string }>>,
  documents: ReadonlyArray<T>,
): Promise<ReadonlyArray<T>> => {
  if (!viewerId) {
    return documents;
  }
  const filters = await loadViewerFilters(db, viewerId);
  if (filters.isErr() || filters.value.length === 0) {
    return documents;
  }
  const texts = new Map(statuses.map((status) => [status.id, htmlToText(status.contentHtml)]));
  return documents.map((document) => {
    const id = document.id;
    const text = texts.get(id);
    if (text === undefined) {
      return document;
    }
    const matches = matchFilters(filters.value, context, text, id);
    return matches.length > 0 ? { ...document, filtered: filteredAttribute(matches) } : document;
  });
};
