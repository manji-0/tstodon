import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { jsonStringArray, runD1, type RepositoryError } from "./d1";
import {
  deleteAccountFlag as deleteAccountFlagSql,
  findAccountFlag as findAccountFlagSql,
  listMediaObjectKeysForAccount as listMediaObjectKeysForAccountSql,
  listSensitizedAccountIds as listSensitizedAccountIdsSql,
  upsertAccountSensitized as upsertAccountSensitizedSql,
} from "./generated/prisma/sql";
import { queryTyped, runTyped } from "./typed-sql";

/** True when an admin forced the account's media to be marked sensitive. */
export const isAccountSensitized = async (
  db: D1Database,
  accountId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ sensitized: number }>(db, findAccountFlagSql(accountId));
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
    queryTyped<{ account_id: string }>(db, listSensitizedAccountIdsSql(jsonStringArray(unique))),
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
  if (!sensitized) {
    const cleared = await runD1(async () => {
      await runTyped(db, deleteAccountFlagSql(accountId));
    });
    return cleared.map(() => undefined);
  }
  const written = await runD1(async () => {
    await runTyped(db, upsertAccountSensitizedSql(accountId, nowIso()));
  });
  return written.map(() => undefined);
};

/** Object keys held by the account, so a purge can drop its bucket objects. */
export const mediaObjectKeysForAccount = async (
  db: D1Database,
  accountId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ object_key: string }>(
      db,
      listMediaObjectKeysForAccountSql(accountId),
    );
    return rows.map((row) => row.object_key);
  });
