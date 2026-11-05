import {
  AccountStanding,
  type AccountStandingValue,
  LocalAccountModeration,
  type LocalAccountModerationValue,
} from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, runD1, type RepositoryError } from "./d1";
import {
  deleteAccountModeration as deleteAccountModerationSql,
  findAccountModeration as findAccountModerationSql,
  listAccountModerations as listAccountModerationsSql,
  listLocalAccountModerations as listLocalAccountModerationsSql,
  upsertAccountFlags as upsertAccountFlagsSql,
  upsertAccountModeration as upsertAccountModerationSql,
} from "./generated/prisma/sql";
import { queryTyped, runTypedBatch } from "./typed-sql";

/**
 * `account_moderation.moderation`: a row exists only while the account is
 * silenced or suspended, so public surfaces can exclude it with one clause.
 */
const StandingColumn = z
  .union([z.literal("Silenced"), z.literal("Suspended")])
  .nullable()
  .transform((moderation): AccountStandingValue =>
    moderation === null ? AccountStanding.inGoodStanding : { kind: moderation },
  );

const flag = z.number().transform((value) => value !== 0);

/**
 * An account's `account_moderation` and `account_flags` columns, read with
 * `LEFT JOIN`s (and `COALESCE(…, 0)` for the flags), as one moderation state.
 */
export const LocalAccountModerationColumns = z
  .object({ moderation: StandingColumn, sensitized: flag, pending: flag, disabled: flag })
  .transform((row): LocalAccountModerationValue => ({
    standing: row.moderation,
    sensitized: row.sensitized,
    login: row.disabled ? { kind: "Disabled" } : { kind: "Enabled" },
    approval: row.pending ? { kind: "Pending" } : { kind: "Approved" },
  }));

const AccountModerationRow = z
  .object({ account_id: z.string() })
  .and(LocalAccountModerationColumns)
  .transform((row) => [row.account_id, row] as const);

const StandingRow = z.object({ moderation: StandingColumn });
const AccountStandingRow = z.object({ account_id: z.string(), moderation: StandingColumn });

/** An account's standing; an account with no row is in good standing. */
export const findAccountStanding = async (
  db: D1Database,
  accountId: string,
): Promise<Result<AccountStandingValue, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findAccountModerationSql(accountId), StandingRow);
    return rows[0]?.moderation ?? AccountStanding.inGoodStanding;
  });

/** The standing of each listed account that is silenced or suspended; the rest are absent. */
export const listAccountStandings = async (
  db: D1Database,
  accountIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, AccountStandingValue>, RepositoryError>> =>
  runD1(async () => {
    const unique = [...new Set(accountIds)];
    if (unique.length === 0) {
      return new Map();
    }
    const rows = await queryTyped(
      db,
      listAccountModerationsSql(jsonStringArray(unique)),
      AccountStandingRow,
    );
    return new Map(rows.map((row) => [row.account_id, row.moderation]));
  });

/** The moderation state of each listed account that exists. */
export const listLocalAccountModerations = async (
  db: D1Database,
  accountIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, LocalAccountModerationValue>, RepositoryError>> =>
  runD1(async () => {
    const unique = [...new Set(accountIds)];
    if (unique.length === 0) {
      return new Map();
    }
    const rows = await queryTyped(
      db,
      listLocalAccountModerationsSql(jsonStringArray(unique)),
      AccountModerationRow,
    );
    return new Map(rows);
  });

/** One account's moderation state; an unknown account reads as in good standing. */
export const findLocalAccountModeration = async (
  db: D1Database,
  accountId: string,
): Promise<Result<LocalAccountModerationValue, RepositoryError>> => {
  const found = await listLocalAccountModerations(db, [accountId]);
  return found.map((states) => states.get(accountId) ?? LocalAccountModeration.inGoodStanding);
};

/** Store an account's whole moderation state, both tables in one batch. */
export const saveLocalAccountModeration = async (
  db: D1Database,
  accountId: string,
  moderation: LocalAccountModerationValue,
): Promise<Result<void, RepositoryError>> => {
  const now = nowIso();
  const written = await runTypedBatch(db, [
    moderation.standing.kind === "InGoodStanding"
      ? deleteAccountModerationSql(accountId)
      : upsertAccountModerationSql(accountId, moderation.standing.kind, now),
    upsertAccountFlagsSql(
      accountId,
      moderation.sensitized ? 1 : 0,
      moderation.approval.kind === "Pending" ? 1 : 0,
      moderation.login.kind === "Disabled" ? 1 : 0,
      now,
    ),
  ]);
  return written.map(() => undefined);
};
