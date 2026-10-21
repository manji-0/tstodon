import { err, ok, type Result } from "neverthrow";
import { type RepositoryError, runD1 } from "./d1";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { RemoteAccountId } from "./remote-account-id";
import { queryTyped, runTyped } from "./typed-sql";
import {
  deleteBlock as deleteBlockSql,
  deleteMute as deleteMuteSql,
  findActiveMute as findActiveMuteSql,
  findBlock as findBlockSql,
  upsertBlock as upsertBlockSql,
  upsertMute as upsertMuteSql,
} from "./generated/prisma/sql";

export type BlockedAccount = Readonly<{
  id: string;
  accountId: string;
  targetActorUri: string;
  createdAt: string;
}>;

export type MutedAccount = Readonly<{
  id: string;
  accountId: string;
  targetActorUri: string;
  notifications: boolean;
  expiresAt: string | null;
  createdAt: string;
}>;

export const blockAccount = async (
  db: D1Database,
  blockerAccountId: string,
  targetAccountId: string | null,
  targetActorUri: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      upsertBlockSql(newEntityId(), blockerAccountId, targetAccountId, targetActorUri, nowIso()),
    );
  });

export const unblockAccount = async (
  db: D1Database,
  blockerAccountId: string,
  targetActorUri: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ target_actor_uri: string }>(
      db,
      deleteBlockSql(blockerAccountId, targetActorUri),
    );
    return rows.length > 0;
  });

export const muteAccount = async (
  db: D1Database,
  accountId: string,
  targetAccountId: string | null,
  targetActorUri: string,
  input: Readonly<{ notifications: boolean; expiresAt: string | null }>,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      upsertMuteSql(
        newEntityId(),
        accountId,
        targetAccountId,
        targetActorUri,
        input.notifications ? 1 : 0,
        input.expiresAt,
        nowIso(),
      ),
    );
  });

export const unmuteAccount = async (
  db: D1Database,
  accountId: string,
  targetActorUri: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ target_actor_uri: string }>(
      db,
      deleteMuteSql(accountId, targetActorUri),
    );
    return rows.length > 0;
  });

export const listBlockedAccounts = async (
  db: D1Database,
  blockerAccountId: string,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<BlockedAccount[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT id, target_account_id, target_actor_uri, created_at FROM blocks
         WHERE blocker_account_id = ? ${where} ${order} LIMIT ?`,
      )
      .bind(blockerAccountId, ...binds, limit)
      .all();
    const rows = (results ?? []) as Array<{
      id: string;
      target_account_id: string | null;
      target_actor_uri: string;
      created_at: string;
    }>;
    // Remote targets carry no local id; they are listed by their `r_…` id.
    return rows.map((row) => ({
      id: row.id,
      accountId: row.target_account_id ?? RemoteAccountId.encode(row.target_actor_uri),
      targetActorUri: row.target_actor_uri,
      createdAt: row.created_at,
    }));
  });

export const listMutedAccounts = async (
  db: D1Database,
  accountId: string,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<MutedAccount[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT id, target_account_id, target_actor_uri, notifications, expires_at, created_at FROM mutes
         WHERE account_id = ?
           AND (expires_at IS NULL OR expires_at > ?) ${where} ${order} LIMIT ?`,
      )
      .bind(accountId, nowIso(), ...binds, limit)
      .all();
    const rows = (results ?? []) as Array<{
      id: string;
      target_account_id: string | null;
      target_actor_uri: string;
      notifications: number;
      expires_at: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      accountId: row.target_account_id ?? RemoteAccountId.encode(row.target_actor_uri),
      targetActorUri: row.target_actor_uri,
      notifications: row.notifications !== 0,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
  });

/** Does `accountId` block `target` (a local account id or a remote actor URI)? */
export const findBlock = async (
  db: D1Database,
  accountId: string,
  target: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => (await queryTyped(db, findBlockSql(accountId, target))).length > 0);

/** The live mute of `target` by `accountId`, with whether it also mutes notifications. */
export const findActiveMute = async (
  db: D1Database,
  accountId: string,
  target: string,
): Promise<Result<Readonly<{ notifications: boolean }> | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ notifications: number | bigint }>(
      db,
      findActiveMuteSql(accountId, target, nowIso()),
    );
    const row = rows[0];
    return row ? { notifications: Number(row.notifications) !== 0 } : undefined;
  });

/**
 * SQL fragment selecting the account ids a viewer must not see: accounts the
 * viewer blocks, accounts that block the viewer, and active muted accounts.
 * Bind order: (viewerId, viewerId, viewerId, nowIso).
 */
export const SUPPRESSED_ACCOUNT_IDS_SQL = `(
  SELECT target_account_id FROM blocks
    WHERE blocker_account_id = ? AND target_account_id IS NOT NULL
  UNION
  SELECT blocker_account_id FROM blocks
    WHERE target_account_id = ? AND blocker_account_id IS NOT NULL
  UNION
  SELECT target_account_id FROM mutes
    WHERE account_id = ? AND target_account_id IS NOT NULL
      AND (expires_at IS NULL OR expires_at > ?)
)`;

/**
 * Who a viewer does not see posts from: local account ids (blocks either
 * way, active mutes) and remote actor URIs (their blocks and active mutes).
 */
export const listSuppressedAuthors = async (
  db: D1Database,
  viewerId: string,
): Promise<
  Result<
    Readonly<{ accountIds: ReadonlySet<string>; actorUris: ReadonlySet<string> }>,
    RepositoryError
  >
> => {
  const now = nowIso();
  const rows = await runD1(async () =>
    Promise.all([
      db
        .prepare(`SELECT id FROM accounts WHERE id IN ${SUPPRESSED_ACCOUNT_IDS_SQL}`)
        .bind(viewerId, viewerId, viewerId, now)
        .all<{ id: string }>(),
      db
        .prepare(
          `SELECT target_actor_uri AS uri FROM blocks WHERE blocker_account_id = ?
           UNION
           SELECT target_actor_uri FROM mutes
           WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .bind(viewerId, viewerId, now)
        .all<{ uri: string }>(),
    ]),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  const [accounts, actors] = rows.value;
  return ok({
    accountIds: new Set((accounts.results ?? []).map((row) => row.id)),
    actorUris: new Set((actors.results ?? []).map((row) => row.uri)),
  });
};
