import { runD1, type RepositoryError } from "./d1";
import { queryTyped, runTyped } from "./typed-sql";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import type { Result } from "neverthrow";
import {
  deleteFilter as deleteFilterSql,
  insertFilter as insertFilterSql,
  insertReport as insertReportSql,
  listFilters as listFiltersSql,
} from "./generated/prisma/sql";

export type FilterRow = {
  id: string;
  account_id: string;
  phrase: string;
  context_json: string;
  whole_word: number;
  irreversible: number;
  expires_at: string | null;
};

export const insertFilter = async (
  db: D1Database,
  input: {
    accountId: string;
    phrase: string;
    context: ReadonlyArray<string>;
    wholeWord: boolean;
    irreversible: boolean;
    expiresAt: string | undefined;
  },
): Promise<Result<FilterRow, RepositoryError>> =>
  runD1(async () => {
    const id = newEntityId();
    const contextJson = JSON.stringify(input.context);
    const wholeWord = input.wholeWord ? 1 : 0;
    const irreversible = input.irreversible ? 1 : 0;
    const expiresAt = input.expiresAt ?? null;
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
    };
  });

export const listFilters = async (
  db: D1Database,
  accountId: string,
): Promise<Result<FilterRow[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<FilterRow>(db, listFiltersSql(accountId));
    return rows.map((row) => ({
      id: row.id ?? "",
      account_id: row.account_id,
      phrase: row.phrase,
      context_json: row.context_json,
      whole_word: row.whole_word,
      irreversible: row.irreversible,
      expires_at: row.expires_at,
    }));
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
