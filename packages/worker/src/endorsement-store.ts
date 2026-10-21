import type { Result } from "neverthrow";
import { type RepositoryError, runD1 } from "./d1";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { queryTyped, runTyped } from "./typed-sql";
import {
  deleteEndorsement as deleteEndorsementSql,
  insertEndorsement as insertEndorsementSql,
} from "./generated/prisma/sql";

export const endorseAccount = async (
  db: D1Database,
  viewerId: string,
  target: Readonly<{ accountId: string | null; actorUri: string }>,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      insertEndorsementSql(newEntityId(), viewerId, target.accountId, target.actorUri, nowIso()),
    );
  });

export const unendorseAccount = async (
  db: D1Database,
  viewerId: string,
  targetId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ target_actor_uri: string }>(
      db,
      deleteEndorsementSql(viewerId, targetId),
    );
    return rows.length > 0;
  });

/** Endorsed targets, newest first, as local account ids or remote actor URIs. */
export const listEndorsements = async (
  db: D1Database,
  viewerId: string,
  limit: number = 40,
  cursor: IdCursor = {},
): Promise<
  Result<
    ReadonlyArray<Readonly<{ id: string; accountId: string | null; actorUri: string }>>,
    RepositoryError
  >
> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT id, target_account_id, target_actor_uri FROM endorsements
         WHERE account_id = ? ${where} ${order} LIMIT ?`,
      )
      .bind(viewerId, ...binds, limit)
      .all();
    const rows = (results ?? []) as Array<{
      id: string;
      target_account_id: string | null;
      target_actor_uri: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      accountId: row.target_account_id,
      actorUri: row.target_actor_uri,
    }));
  });
