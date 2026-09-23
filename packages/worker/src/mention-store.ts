import { err, ok, type Result } from "neverthrow";
import { runD1, runD1Batch, type RepositoryError } from "./d1";
import { d1PrepareTyped, queryTyped } from "./typed-sql";
import {
  deleteStatusMentions as deleteStatusMentionsSql,
  insertStatusMention as insertStatusMentionSql,
  isAccountMentionedOnStatus as isAccountMentionedOnStatusSql,
  listMentionedAccountIds as listMentionedAccountIdsSql,
} from "./generated/prisma/sql";

export const replaceStatusMentions = async (
  db: D1Database,
  statusId: string,
  accountIds: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> => {
  const statements: D1PreparedStatement[] = [
    d1PrepareTyped(db, deleteStatusMentionsSql(statusId)),
    ...accountIds.map((accountId) =>
      d1PrepareTyped(db, insertStatusMentionSql(statusId, accountId)),
    ),
  ];
  const batched = await runD1Batch(db, statements);
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok(undefined);
};

export const isAccountMentionedOnStatus = async (
  db: D1Database,
  statusId: string,
  accountId: string,
): Promise<Result<boolean, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped<{ ok: number }>(db, isAccountMentionedOnStatusSql(statusId, accountId));
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(queried.value.length > 0);
};

export const listMentionedAccountIds = async (
  db: D1Database,
  statusId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped<{ account_id: string }>(
      db,
      listMentionedAccountIdsSql(statusId),
    );
    return results.map((row) => row.account_id);
  });
