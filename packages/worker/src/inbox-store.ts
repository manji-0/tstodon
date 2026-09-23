import { runD1, type RepositoryError } from "./d1";
import { queryTyped, runTyped } from "./typed-sql";
import { nowIso } from "./clock";
import type { Result } from "neverthrow";
import {
  inboxActivityExists as inboxActivityExistsSql,
  insertInboxActivity as insertInboxActivitySql,
} from "./generated/prisma/sql";

export const inboxActivityExists = async (
  db: D1Database,
  activityId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, inboxActivityExistsSql(activityId));
    return rows.length > 0;
  });

export const insertInboxActivity = async (
  db: D1Database,
  input: {
    activityId: string;
    kind: string;
    payload: unknown;
  },
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    // Prisma 7 exposes TypedSQL writes through $queryRawTyped (no $executeRawTyped yet).
    await runTyped(
      db,
      insertInboxActivitySql(input.activityId, input.kind, JSON.stringify(input.payload), nowIso()),
    );
  });
