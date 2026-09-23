import { runD1, runD1Batch, type RepositoryError } from "./d1";
import { err, ok, type Result } from "neverthrow";

export const replaceStatusMentions = async (
  db: D1Database,
  statusId: string,
  accountIds: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> => {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO status_mentions (status_id, account_id) VALUES (?, ?)`,
  );
  const statements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM status_mentions WHERE status_id = ?`).bind(statusId),
    ...accountIds.map((accountId) => insert.bind(statusId, accountId)),
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
  const queried = await runD1(() =>
    db
      .prepare(`SELECT 1 AS ok FROM status_mentions WHERE status_id = ? AND account_id = ?`)
      .bind(statusId, accountId)
      .first<{ ok: number }>(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(Boolean(queried.value));
};

export const listMentionedAccountIds = async (
  db: D1Database,
  statusId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(`SELECT account_id FROM status_mentions WHERE status_id = ?`)
      .bind(statusId)
      .all<{ account_id: string }>();
    return (results ?? []).map((row) => row.account_id);
  });
