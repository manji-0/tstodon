import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { jsonStringArray, runD1, type RepositoryError } from "./d1";
import {
  clearAccountSensitized as clearAccountSensitizedSql,
  findAccountFlag as findAccountFlagSql,
  listMediaObjectKeysForAccount as listMediaObjectKeysForAccountSql,
  listDisabledAccountIds as listDisabledAccountIdsSql,
  listPendingAccountIds as listPendingAccountIdsSql,
  listSensitizedAccountIds as listSensitizedAccountIdsSql,
  setAccountApproved as setAccountApprovedSql,
  upsertAccountDisabled as upsertAccountDisabledSql,
  upsertAccountPending as upsertAccountPendingSql,
  upsertAccountSensitized as upsertAccountSensitizedSql,
} from "./generated/prisma/sql";
import { queryTyped, runTyped } from "./typed-sql";

const SensitizedRow = z.object({ sensitized: z.number() });
const AccountIdRow = z.object({ account_id: z.string() });
const ObjectKeyRow = z.object({ object_key: z.string() });

/** True when an admin forced the account's media to be marked sensitive. */
export const isAccountSensitized = async (
  db: D1Database,
  accountId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findAccountFlagSql(accountId), SensitizedRow);
    return (rows[0]?.sensitized ?? 0) !== 0;
  });

/** Of the given account ids, the ones an admin has sensitized. */
export const sensitizedAccountIds = async (
  db: D1Database,
  accountIds: ReadonlyArray<string>,
): Promise<Result<ReadonlySet<string>, RepositoryError>> => {
  const unique = [...new Set(accountIds)];
  if (unique.length === 0) {
    return ok(new Set<string>());
  }
  const queried = await runD1(async () =>
    queryTyped(db, listSensitizedAccountIdsSql(jsonStringArray(unique)), AccountIdRow),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(new Set(queried.value.map((row) => row.account_id)));
};

export const setAccountSensitized = async (
  db: D1Database,
  accountId: string,
  sensitized: boolean,
): Promise<Result<void, RepositoryError>> => {
  // The row is kept when cleared: it also carries the approval state.
  const written = await runD1(async () => {
    await runTyped(
      db,
      sensitized
        ? upsertAccountSensitizedSql(accountId, nowIso())
        : clearAccountSensitizedSql(accountId, nowIso()),
    );
  });
  return written.map(() => undefined);
};

/** Of the given account ids, the ones still waiting for approval. */
export const pendingAccountIds = async (
  db: D1Database,
  accountIds: ReadonlyArray<string>,
): Promise<Result<ReadonlySet<string>, RepositoryError>> => {
  const unique = [...new Set(accountIds)];
  if (unique.length === 0) {
    return ok(new Set<string>());
  }
  const queried = await runD1(async () =>
    queryTyped(db, listPendingAccountIdsSql(jsonStringArray(unique)), AccountIdRow),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(new Set(queried.value.map((row) => row.account_id)));
};

/** Hold a freshly registered account until an admin approves it. */
export const markAccountPending = async (
  db: D1Database,
  accountId: string,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await runTyped(db, upsertAccountPendingSql(accountId, nowIso()));
  });
  return written.map(() => undefined);
};

/** Of the given account ids, the ones whose login an admin disabled. */
export const disabledAccountIds = async (
  db: D1Database,
  accountIds: ReadonlyArray<string>,
): Promise<Result<ReadonlySet<string>, RepositoryError>> => {
  const unique = [...new Set(accountIds)];
  if (unique.length === 0) {
    return ok(new Set<string>());
  }
  const queried = await runD1(async () =>
    queryTyped(db, listDisabledAccountIdsSql(jsonStringArray(unique)), AccountIdRow),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(new Set(queried.value.map((row) => row.account_id)));
};

/**
 * Block or restore an account's login (`disable` / `enable`). Silence,
 * suspension, and approval are separate bits on the same row.
 */
export const setAccountDisabled = async (
  db: D1Database,
  accountId: string,
  disabled: boolean,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await runTyped(db, upsertAccountDisabledSql(accountId, disabled ? 1 : 0, nowIso()));
  });
  return written.map(() => undefined);
};

/** Approve a pending account (idempotent; absent accounts are approved). */
export const approveAccount = async (
  db: D1Database,
  accountId: string,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await runTyped(db, setAccountApprovedSql(accountId, nowIso()));
  });
  return written.map(() => undefined);
};

/** Object keys held by the account, so a purge can drop its bucket objects. */
export const mediaObjectKeysForAccount = async (
  db: D1Database,
  accountId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listMediaObjectKeysForAccountSql(accountId), ObjectKeyRow);
    return rows.map((row) => row.object_key);
  });
