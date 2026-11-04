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

const IdRow = z.object({ id: z.string() });
const IdStatusIdRow = z.object({ id: z.string().nullable(), status_id: z.string() });
const NullableIdRow = z.object({ id: z.string().nullable() });

export const FilterContextSchema = z.array(z.string());

/** A `filters` row; a column of the wrong type reads as its default. */
export const FilterRowSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  phrase: z.string().catch(""),
  context_json: z.string().catch("[]"),
  whole_word: z.number().catch(0),
  irreversible: z.number().catch(0),
  expires_at: z.string().nullable().catch(null),
  keywords_json: z.string().catch("[]"),
});

export type FilterRow = z.infer<typeof FilterRowSchema>;

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
    return queryTyped(db, listFiltersSql(accountId), FilterRowSchema);
  });

export const deleteFilter = async (
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, deleteFilterSql(id, accountId), IdRow);
    return rows.length > 0;
  });

export const findFilterById = async (
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Result<FilterRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findFilterByIdSql(id, accountId), FilterRowSchema);
    return rows[0];
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
    const rows = await queryTyped(
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
      IdRow,
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
    const rows = await queryTyped(db, listFilterStatusesSql(filterId), IdStatusIdRow);
    return rows.flatMap((row) => (row.id ? [{ id: row.id, status_id: row.status_id }] : []));
  });

/** Narrow a filter to a status; adding the same status again answers the existing entry. */
export const addFilterStatus = async (
  db: D1Database,
  filterId: string,
  statusId: string,
): Promise<Result<FilterStatus | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      insertFilterStatusSql(newEntityId(), filterId, statusId, nowIso()),
      IdStatusIdRow,
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
    const rows = await queryTyped(db, findFilterStatusByIdSql(accountId, id), IdStatusIdRow);
    const row = rows[0];
    return row?.id ? { id: row.id, status_id: row.status_id } : undefined;
  });

export const removeFilterStatusById = async (
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, deleteFilterStatusByIdSql(accountId, id), NullableIdRow);
    return rows.length > 0;
  });

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([FilterContextSchema]);
