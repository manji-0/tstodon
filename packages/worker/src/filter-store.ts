import { type RepositoryError, runD1 } from "./d1";
import { queryTyped, runTyped } from "./typed-sql";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import { schemaResult, warmSchemas } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import {
  deleteFilter as deleteFilterSql,
  deleteFilterStatusById as deleteFilterStatusByIdSql,
  findFilterById as findFilterByIdSql,
  findFilterStatusById as findFilterStatusByIdSql,
  insertFilter as insertFilterSql,
  insertFilterStatus as insertFilterStatusSql,
  listFilters as listFiltersSql,
  listFilterStatuses as listFilterStatusesSql,
  updateFilter as updateFilterSql,
} from "./generated/prisma/sql";

export const FilterContextSchema = z.array(z.string());

export type FilterRow = {
  id: string;
  account_id: string;
  phrase: string;
  context_json: string;
  whole_word: number;
  irreversible: number;
  expires_at: string | null;
  keywords_json: string;
};

export const FilterKeywordSchema = z.object({
  id: z.string().min(1),
  keyword: z.string().min(1),
  whole_word: z.boolean(),
});

export type FilterKeyword = z.infer<typeof FilterKeywordSchema>;

const parseKeywords = schemaResult(z.array(FilterKeywordSchema));

/** Stored keywords, or a synthetic one built from the v1 `phrase`. */
export const filterKeywords = (row: FilterRow): ReadonlyArray<FilterKeyword> => {
  const parsed = parseKeywords(JSON.parse(row.keywords_json.length > 0 ? row.keywords_json : "[]"));
  if (parsed.isOk() && parsed.value.length > 0) {
    return parsed.value;
  }
  return [{ id: row.id, keyword: row.phrase, whole_word: row.whole_word === 1 }];
};

export const filterRowFrom = (raw: Record<string, unknown>): FilterRow | undefined => {
  const id = typeof raw.id === "string" ? raw.id : undefined;
  const accountId = typeof raw.account_id === "string" ? raw.account_id : undefined;
  if (!id || !accountId) {
    return undefined;
  }
  return {
    id,
    account_id: accountId,
    phrase: typeof raw.phrase === "string" ? raw.phrase : "",
    context_json: typeof raw.context_json === "string" ? raw.context_json : "[]",
    whole_word: typeof raw.whole_word === "number" ? raw.whole_word : 0,
    irreversible: typeof raw.irreversible === "number" ? raw.irreversible : 0,
    expires_at: typeof raw.expires_at === "string" ? raw.expires_at : null,
    keywords_json: typeof raw.keywords_json === "string" ? raw.keywords_json : "[]",
  };
};

const keywordsJson = (keywords: ReadonlyArray<FilterKeyword>, fallbackPhrase: string): string =>
  keywords.length > 0
    ? JSON.stringify(keywords)
    : JSON.stringify([{ id: newEntityId(), keyword: fallbackPhrase, whole_word: false }]);

export const insertFilter = async (
  db: D1Database,
  input: {
    accountId: string;
    phrase: string;
    context: ReadonlyArray<string>;
    wholeWord: boolean;
    irreversible: boolean;
    expiresAt: string | undefined;
    keywords?: ReadonlyArray<FilterKeyword>;
  },
): Promise<Result<FilterRow, RepositoryError>> =>
  runD1(async () => {
    const id = newEntityId();
    const contextJson = JSON.stringify(input.context);
    const wholeWord = input.wholeWord ? 1 : 0;
    const irreversible = input.irreversible ? 1 : 0;
    const expiresAt = input.expiresAt ?? null;
    const keywords = keywordsJson(input.keywords ?? [], input.phrase);
    await runTyped(
      db,
      insertFilterSql(
        id,
        input.accountId,
        input.phrase,
        contextJson,
        wholeWord,
        irreversible,
        expiresAt,
        keywords,
        nowIso(),
      ),
    );
    return {
      id,
      account_id: input.accountId,
      phrase: input.phrase,
      context_json: contextJson,
      whole_word: wholeWord,
      irreversible: irreversible,
      expires_at: expiresAt,
      keywords_json: keywords,
    };
  });

export const listFilters = async (
  db: D1Database,
  accountId: string,
): Promise<Result<FilterRow[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listFiltersSql(accountId));
    return rows.flatMap((raw) => {
      const row = filterRowFrom(raw);
      return row ? [row] : [];
    });
  });

export const deleteFilter = async (
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(db, deleteFilterSql(id, accountId));
    return rows.length > 0;
  });

export const findFilterById = async (
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Result<FilterRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findFilterByIdSql(id, accountId));
    return rows[0] === undefined ? undefined : filterRowFrom(rows[0]);
  });

export const updateFilter = async (
  db: D1Database,
  accountId: string,
  id: string,
  input: {
    phrase: string;
    context: ReadonlyArray<string>;
    wholeWord: boolean;
    irreversible: boolean;
    expiresAt: string | null;
    keywords: ReadonlyArray<FilterKeyword>;
  },
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(
      db,
      updateFilterSql(
        id,
        accountId,
        input.phrase,
        JSON.stringify(input.context),
        input.wholeWord ? 1 : 0,
        input.irreversible ? 1 : 0,
        input.expiresAt,
        input.keywords.length > 0
          ? JSON.stringify(input.keywords)
          : JSON.stringify([{ id, keyword: input.phrase, whole_word: input.wholeWord }]),
      ),
    );
    return rows.length > 0;
  });

/** Status ids a filter is narrowed to. */

/** Mastodon's FilterStatus: one status a filter is narrowed to, with its own id. */
export type FilterStatus = Readonly<{ id: string; status_id: string }>;

export const listFilterStatuses = async (
  db: D1Database,
  filterId: string,
): Promise<Result<FilterStatus[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string | null; status_id: string }>(
      db,
      listFilterStatusesSql(filterId),
    );
    return rows.flatMap((row) => (row.id ? [{ id: row.id, status_id: row.status_id }] : []));
  });

/** Narrow a filter to a status; adding the same status again answers the existing entry. */
export const addFilterStatus = async (
  db: D1Database,
  filterId: string,
  statusId: string,
): Promise<Result<FilterStatus | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string | null; status_id: string }>(
      db,
      insertFilterStatusSql(newEntityId(), filterId, statusId, nowIso()),
    );
    const row = rows[0];
    return row?.id ? { id: row.id, status_id: row.status_id } : undefined;
  });

/** A FilterStatus by id, when it belongs to one of the account's filters. */
export const findFilterStatusById = async (
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Result<FilterStatus | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string | null; status_id: string }>(
      db,
      findFilterStatusByIdSql(accountId, id),
    );
    const row = rows[0];
    return row?.id ? { id: row.id, status_id: row.status_id } : undefined;
  });

export const removeFilterStatusById = async (
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string | null }>(
      db,
      deleteFilterStatusByIdSql(accountId, id),
    );
    return rows.length > 0;
  });

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([FilterContextSchema]);
