import { runD1, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import type { Result } from "neverthrow";

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
    await db
      .prepare(
        `INSERT INTO filters (
          id, account_id, phrase, context_json, whole_word, irreversible, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.accountId,
        input.phrase,
        JSON.stringify(input.context),
        input.wholeWord ? 1 : 0,
        input.irreversible ? 1 : 0,
        input.expiresAt ?? null,
        nowIso(),
      )
      .run();
    return {
      id,
      account_id: input.accountId,
      phrase: input.phrase,
      context_json: JSON.stringify(input.context),
      whole_word: input.wholeWord ? 1 : 0,
      irreversible: input.irreversible ? 1 : 0,
      expires_at: input.expiresAt ?? null,
    };
  });

export const listFilters = async (
  db: D1Database,
  accountId: string,
): Promise<Result<FilterRow[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT id, account_id, phrase, context_json, whole_word, irreversible, expires_at
         FROM filters WHERE account_id = ? ORDER BY created_at DESC`,
      )
      .bind(accountId)
      .all<FilterRow>();
    return results ?? [];
  });

export const deleteFilter = async (
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const result = await db
      .prepare(`DELETE FROM filters WHERE id = ? AND account_id = ?`)
      .bind(id, accountId)
      .run();
    return (result.meta.changes ?? 0) > 0;
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
    await db
      .prepare(
        `INSERT INTO reports (id, account_id, target_account_id, status_ids_json, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.accountId,
        input.targetAccountId,
        JSON.stringify(input.statusIds),
        input.comment,
        nowIso(),
      )
      .run();
    return { id };
  });
