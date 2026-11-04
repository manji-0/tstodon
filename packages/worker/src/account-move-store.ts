import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, parseRows, runD1, type RepositoryError } from "./d1";
import {
  cancelAccountMove as cancelAccountMoveSql,
  claimAccountMove as claimAccountMoveSql,
  findAccountMove as findAccountMoveSql,
  listAcceptedFollowsPage as listAcceptedFollowsPageSql,
  listAccountMovesByIdsJson as listAccountMovesByIdsJsonSql,
} from "./generated/prisma/sql";
import type { FollowOptions } from "./follow-store";
import { parseJsonColumn } from "./json-column";
import { queryTyped } from "./typed-sql";

/** Where a local account moved to, and when. */
export type AccountMove = Readonly<{ acct: string; targetUri: string; movedAt: string }>;

/**
 * The account's last move: standing, or cancelled. A cancelled move still
 * counts for the cooldown, which runs from `move.movedAt`.
 */
export type AccountMoveRecord =
  | Readonly<{ kind: "Moved"; move: AccountMove }>
  | Readonly<{ kind: "Cancelled"; move: AccountMove; cancelledAt: string }>;

const MoveRowSchema = z.object({
  acct: z.string().min(1),
  target_uri: z.string().min(1),
  moved_at: z.string().min(1),
  cancelled_at: z.string().nullable(),
});

const parseMoveRow = schemaResult(MoveRowSchema);

/** The last move of the account, standing or cancelled; `undefined` when it never moved. */
export const findAccountMoveRecord = async (
  db: D1Database,
  accountId: string,
): Promise<Result<AccountMoveRecord | undefined, RepositoryError>> =>
  runD1(async () => {
    const row = parseMoveRow((await queryTyped(db, findAccountMoveSql(accountId)))[0]);
    if (row.isErr()) {
      return undefined;
    }
    const move = {
      acct: row.value.acct,
      targetUri: row.value.target_uri,
      movedAt: row.value.moved_at,
    };
    return row.value.cancelled_at === null
      ? { kind: "Moved", move }
      : { kind: "Cancelled", move, cancelledAt: row.value.cancelled_at };
  });

/** The move the account's actor and profile show now; `undefined` when it never moved or cancelled. */
export const findAccountMove = async (
  db: D1Database,
  accountId: string,
): Promise<Result<AccountMove | undefined, RepositoryError>> =>
  (await findAccountMoveRecord(db, accountId)).map((record) =>
    record?.kind === "Moved" ? record.move : undefined,
  );

/** Cancel the standing move. Resolves to false when there was none. */
export const cancelAccountMove = async (
  db: D1Database,
  accountId: string,
  cancelledAt: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(
    async () => (await queryTyped(db, cancelAccountMoveSql(accountId, cancelledAt))).length > 0,
  );

/** The move targets of whichever of `accountIds` moved, by account id. */
export const listAccountMoveTargets = async (
  db: D1Database,
  accountIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, string>, RepositoryError>> => {
  if (accountIds.length === 0) {
    return ok(new Map());
  }
  const rows = await runD1(async () =>
    queryTyped(db, listAccountMovesByIdsJsonSql(jsonStringArray([...new Set(accountIds)]))),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  return ok(
    new Map(
      parseRows(z.object({ account_id: z.string(), target_uri: z.string() }), rows.value).map(
        (row) => [row.account_id, row.target_uri],
      ),
    ),
  );
};

/**
 * Record the move, unless the account moved after `cooldownStartedBefore`
 * (one statement, so two moves cannot both pass the cooldown). Recording the
 * standing move again keeps its time; a cancelled move is over, so a move to
 * the same target is a new one and the cooldown holds. `false` when the
 * cooldown refused it.
 */
export const claimAccountMove = async (
  db: D1Database,
  accountId: string,
  move: AccountMove,
  cooldownStartedBefore: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(
    async () =>
      (
        await queryTyped(
          db,
          claimAccountMoveSql(
            accountId,
            move.acct,
            move.targetUri,
            move.movedAt,
            cooldownStartedBefore,
          ),
        )
      ).length > 0,
  );

/** An accepted local follow of an account, with its options; `id` orders the pages. */
export type LocalFollowEdge = Readonly<{
  id: string;
  followerAccountId: string;
  options: FollowOptions;
}>;

const FollowEdgeRowSchema = z.object({
  id: z.string().min(1),
  follower_account_id: z.string().min(1),
  reblogs: z.number(),
  notify: z.number(),
  languages_json: z.string(),
});

/** One page of the accepted local follows of `targetAccountId`, after `afterId` in id order. */
export const listAcceptedFollowsPage = async (
  db: D1Database,
  targetAccountId: string,
  afterId: string,
  limit: number,
): Promise<Result<ReadonlyArray<LocalFollowEdge>, RepositoryError>> =>
  runD1(async () =>
    parseRows(
      FollowEdgeRowSchema,
      await queryTyped(db, listAcceptedFollowsPageSql(targetAccountId, afterId, limit)),
    ).map((row) => ({
      id: row.id,
      followerAccountId: row.follower_account_id,
      options: {
        reblogs: row.reblogs !== 0,
        notify: row.notify !== 0,
        languages: parseJsonColumn(z.array(z.string()), row.languages_json).unwrapOr([]),
      },
    })),
  );
