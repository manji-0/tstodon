import { schemaResult } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, runD1, type RepositoryError } from "./d1";
import {
  deleteAccountModeration as deleteAccountModerationSql,
  findAccountModeration as findAccountModerationSql,
  listAccountModerations as listAccountModerationsSql,
  upsertAccountModeration as upsertAccountModerationSql,
} from "./generated/prisma/sql";
import { queryTyped, runTyped } from "./typed-sql";

export const AccountModerationSchema = z.union([z.literal("Silenced"), z.literal("Suspended")]);

export type AccountModeration = z.infer<typeof AccountModerationSchema>;

const parseModeration = schemaResult(AccountModerationSchema);

/** `null` means the account is in good standing (no row). */
export const getAccountModeration = async (
  db: D1Database,
  accountId: string,
): Promise<Result<AccountModeration | null, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ moderation: string }>(db, findAccountModerationSql(accountId));
    const parsed = parseModeration(rows[0]?.moderation);
    return parsed.isOk() ? parsed.value : null;
  });

export const listAccountModerations = async (
  db: D1Database,
  accountIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, AccountModeration>, RepositoryError>> =>
  runD1(async () => {
    const unique = [...new Set(accountIds)];
    const moderations = new Map<string, AccountModeration>();
    if (unique.length === 0) {
      return moderations;
    }
    const rows = await queryTyped<{ account_id: string; moderation: string }>(
      db,
      listAccountModerationsSql(jsonStringArray(unique)),
    );
    for (const row of rows) {
      const parsed = parseModeration(row.moderation);
      if (parsed.isOk()) {
        moderations.set(row.account_id, parsed.value);
      }
    }
    return moderations;
  });

/** Set (Silenced/Suspended) or clear (`null`) an account's moderation state. */
export const setAccountModeration = async (
  db: D1Database,
  accountId: string,
  moderation: AccountModeration | null,
): Promise<Result<void, RepositoryError>> => {
  if (moderation === null) {
    const cleared = await runD1(async () => {
      await runTyped(db, deleteAccountModerationSql(accountId));
    });
    return cleared.map(() => undefined);
  }
  const written = await runD1(async () => {
    await runTyped(db, upsertAccountModerationSql(accountId, moderation, nowIso()));
  });
  return written.map(() => undefined);
};
