import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { runD1, runD1Batch, type RepositoryError } from "./d1";
import {
  completeStatusIdempotency as completeStatusIdempotencySql,
  findStatusIdempotency as findStatusIdempotencySql,
  pruneStatusIdempotency as pruneStatusIdempotencySql,
  releaseStatusIdempotency as releaseStatusIdempotencySql,
  reserveStatusIdempotency as reserveStatusIdempotencySql,
} from "./generated/prisma/sql";
import { d1PrepareTyped, queryTyped } from "./typed-sql";

/** Mastodon keeps `Idempotency-Key` results for up to an hour. */
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;

export type IdempotentStatusLookup = Readonly<{
  /** The status created for this key, or `null` while the first request runs. */
  statusId: string | null;
}>;

const expiredBefore = (): string => new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString();

export const findStatusIdempotency = async (
  db: D1Database,
  accountId: string,
  key: string,
): Promise<Result<IdempotentStatusLookup | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ status_id: string }>(
      db,
      findStatusIdempotencySql(accountId, key, expiredBefore()),
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return { statusId: row.status_id.length > 0 ? row.status_id : null };
  });

/**
 * Claim the key. False when another request already holds it (the caller should
 * re-check for a finished response).
 */
export const reserveStatusIdempotency = async (
  db: D1Database,
  accountId: string,
  key: string,
): Promise<Result<boolean, RepositoryError>> => {
  const batched = await runD1Batch(db, [
    d1PrepareTyped(db, pruneStatusIdempotencySql(accountId, expiredBefore())),
    d1PrepareTyped(db, reserveStatusIdempotencySql(accountId, key, nowIso())),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  const rows = batched.value[1]?.results ?? [];
  return ok(rows.length > 0);
};

export const completeStatusIdempotency = async (
  db: D1Database,
  accountId: string,
  key: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await queryTyped(db, completeStatusIdempotencySql(accountId, key, statusId));
  });
  return written.map(() => undefined);
};

/** Drop the claim so the client can retry the same key after a failure. */
export const releaseStatusIdempotency = async (
  db: D1Database,
  accountId: string,
  key: string,
): Promise<Result<void, RepositoryError>> => {
  const released = await runD1(async () => {
    await queryTyped(db, releaseStatusIdempotencySql(accountId, key));
  });
  return released.map(() => undefined);
};
