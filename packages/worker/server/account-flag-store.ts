import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { jsonStringArray, runD1, type RepositoryError } from "./d1";
import {
  listMediaObjectKeysForAccount as listMediaObjectKeysForAccountSql,
  listSensitizedAccountIds as listSensitizedAccountIdsSql,
} from "./generated/prisma/sql";
import { queryTyped } from "./typed-sql";

const AccountIdRow = z.object({ account_id: z.string() });
const ObjectKeyRow = z.object({ object_key: z.string() });

/**
 * Of the given account ids, the ones an admin has sensitized. Status rendering
 * needs only this one bit; `account-moderation-store` reads and writes the
 * whole moderation state.
 */
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

/** Object keys held by the account, so a purge can drop its bucket objects. */
export const mediaObjectKeysForAccount = async (
  db: D1Database,
  accountId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listMediaObjectKeysForAccountSql(accountId), ObjectKeyRow);
    return rows.map((row) => row.object_key);
  });
