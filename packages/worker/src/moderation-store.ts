import { runD1, type RepositoryError } from "./d1";
import { queryTyped, runTyped } from "./typed-sql";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import { schemaResult } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import {
  deleteFilter as deleteFilterSql,
  deleteFilterStatus as deleteFilterStatusSql,
  findFilterById as findFilterByIdSql,
  insertFilterStatus as insertFilterStatusSql,
  listFilterStatusIds as listFilterStatusIdsSql,
  insertFilter as insertFilterSql,
  insertReport as insertReportSql,
  listFilters as listFiltersSql,
  updateFilter as updateFilterSql,
} from "./generated/prisma/sql";

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
export const listFilterStatusIds = async (
  db: D1Database,
  filterId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ status_id: string }>(db, listFilterStatusIdsSql(filterId));
    return rows.map((row) => row.status_id);
  });

export const addFilterStatuses = async (
  db: D1Database,
  filterId: string,
  statusIds: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    for (const statusId of [...new Set(statusIds)].filter((id) => id.length > 0)) {
      await runTyped(db, insertFilterStatusSql(filterId, statusId, nowIso()));
    }
  });
  return written.map(() => undefined);
};

export const removeFilterStatus = async (
  db: D1Database,
  filterId: string,
  statusId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ status_id: string }>(
      db,
      deleteFilterStatusSql(filterId, statusId),
    );
    return rows.length > 0;
  });

export const insertReport = async (
  db: D1Database,
  input: {
    accountId: string;
    targetAccountId: string;
    statusIds: ReadonlyArray<string>;
    comment: string;
  },
): Promise<Result<{ id: string }, RepositoryError>> =>
  runD1(async () => {
    const id = newEntityId();
    await runTyped(
      db,
      insertReportSql(
        id,
        input.accountId,
        input.targetAccountId,
        JSON.stringify(input.statusIds),
        input.comment,
        nowIso(),
      ),
    );
    return { id };
  });
