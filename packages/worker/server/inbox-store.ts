import { InboxClaim, type InboxClaimValue } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { runD1, type RepositoryError } from "./d1";
import { CountedRow, queryTyped, runTyped } from "./typed-sql";
import {
  claimInboxActivity as claimInboxActivitySql,
  completeInboxActivity as completeInboxActivitySql,
  findInboxActivityState as findInboxActivityStateSql,
  releaseInboxActivity as releaseInboxActivitySql,
  releaseStaleInboxClaims as releaseStaleInboxClaimsSql,
} from "./generated/prisma/sql";

const StateRow = z.object({ state: z.literal(["Processing", "Processed"]) });

/** The stored state of an activity id, `undefined` when the inbox holds no row for it. */
export const inboxActivityState = async (
  db: D1Database,
  activityId: string,
): Promise<Result<"Processing" | "Processed" | undefined, RepositoryError>> =>
  runD1(async () => {
    const [row] = await queryTyped(db, findInboxActivityStateSql(activityId), StateRow);
    return row?.state;
  });

/**
 * Claim `activityId` for this delivery (see `claimInboxActivity.sql`). When
 * another delivery holds it, its state says whether that one is still
 * applying it; a row gone between the two reads was released, and counts as
 * in flight so the sender retries.
 */
export const claimInboxActivity = async (
  db: D1Database,
  input: Readonly<{ activityId: string; payload: unknown }>,
  nowMs: number = Date.now(),
): Promise<Result<InboxClaimValue, RepositoryError>> =>
  runD1(async (): Promise<InboxClaimValue> => {
    const claimed = await queryTyped(
      db,
      claimInboxActivitySql(
        input.activityId,
        JSON.stringify(input.payload),
        new Date(nowMs).toISOString(),
        InboxClaim.staleBefore(nowMs),
      ),
      CountedRow,
    );
    if (claimed.length > 0) {
      return { kind: "Acquired" };
    }
    const [held] = await queryTyped(db, findInboxActivityStateSql(input.activityId), StateRow);
    return held?.state === "Processed" ? { kind: "Processed" } : { kind: "InFlight" };
  });

/** Mark a claimed activity handled; `kind` is its type, or the rejection's kind. */
export const completeInboxActivity = async (
  db: D1Database,
  activityId: string,
  kind: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, completeInboxActivitySql(activityId, kind));
  });

/** Give back the claim of an activity whose apply failed. */
export const releaseInboxActivity = async (
  db: D1Database,
  activityId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, releaseInboxActivitySql(activityId));
  });

/** Delete up to `limit` stale claims (see `releaseStaleInboxClaims.sql`); returns how many went. */
export const releaseStaleInboxClaims = async (
  db: D1Database,
  nowMs: number = Date.now(),
  limit: number = 500,
): Promise<Result<number, RepositoryError>> =>
  runD1(
    async () =>
      (await runTyped(db, releaseStaleInboxClaimsSql(InboxClaim.staleBefore(nowMs), limit))).meta
        .changes ?? 0,
  );
