import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { type RepositoryError, runD1 } from "./d1";
import {
  deleteRemoteBlock as deleteRemoteBlockSql,
  findRemoteBlock as findRemoteBlockSql,
  insertRemoteBlock as insertRemoteBlockSql,
} from "./generated/prisma/sql";
import { CountedRow, queryTyped, runTyped } from "./typed-sql";

/** Record that `actorUri` blocks the local account, as Mastodon's inbound `Block`. */
export const recordRemoteBlock = async (
  db: D1Database,
  actorUri: string,
  accountId: string,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await runTyped(db, insertRemoteBlockSql(actorUri, accountId, nowIso()));
  });
  return written.isErr() ? err(written.error) : ok(undefined);
};

/** Lift `actorUri`'s block of the local account, as an inbound `Undo(Block)`. */
export const deleteRemoteBlock = async (
  db: D1Database,
  actorUri: string,
  accountId: string,
): Promise<Result<void, RepositoryError>> => {
  const removed = await runD1(async () => {
    await runTyped(db, deleteRemoteBlockSql(actorUri, accountId));
  });
  return removed.isErr() ? err(removed.error) : ok(undefined);
};

/** Does `actorUri` block the local account? */
export const findRemoteBlock = async (
  db: D1Database,
  actorUri: string,
  accountId: string,
): Promise<Result<boolean, RepositoryError>> => {
  if (actorUri.length === 0) {
    return ok(false);
  }
  const rows = await runD1(async () =>
    queryTyped(db, findRemoteBlockSql(actorUri, accountId), CountedRow),
  );
  return rows.isErr() ? err(rows.error) : ok(rows.value.length > 0);
};
