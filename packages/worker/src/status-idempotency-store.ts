import { z } from "zod";
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
import { d1PrepareTyped, CountedRow, queryTyped } from "./typed-sql";

/** What a finished `Idempotency-Key` request stored: a status, or a status to post later. */
export type IdempotentRecord =
  | Readonly<{ kind: "Status"; id: string }>
  | Readonly<{ kind: "ScheduledStatus"; id: string }>;

/** A key whose first request is still running, or the record it finished with. */
export type IdempotentStatusLookup = Readonly<{ kind: "Pending" }> | IdempotentRecord;

const IdempotencyRow = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Pending") }),
  z.object({ kind: z.literal("Status"), status_id: z.string().min(1) }),
  z.object({ kind: z.literal("ScheduledStatus"), status_id: z.string().min(1) }),
]);

/** Mastodon keeps `Idempotency-Key` results for up to an hour. */
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;

const expiredBefore = (): string => new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString();

export const findStatusIdempotency = async (
  db: D1Database,
  accountId: string,
  key: string,
): Promise<Result<IdempotentStatusLookup | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      findStatusIdempotencySql(accountId, key, expiredBefore()),
      IdempotencyRow,
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return row.kind === "Pending" ? row : { kind: row.kind, id: row.status_id };
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
  record: IdempotentRecord,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await queryTyped(
      db,
      completeStatusIdempotencySql(accountId, key, record.kind, record.id),
      CountedRow,
    );
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
    await queryTyped(db, releaseStatusIdempotencySql(accountId, key), CountedRow);
  });
  return released.map(() => undefined);
};
