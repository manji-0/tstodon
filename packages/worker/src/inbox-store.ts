import { runD1, type RepositoryError } from "./d1";
import { nowIso } from "./clock";
import type { Result } from "neverthrow";

export const inboxActivityExists = async (
  db: D1Database,
  activityId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(`SELECT activity_id FROM inbox_activities WHERE activity_id = ?`)
      .bind(activityId)
      .first();
    return Boolean(row);
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
    await db
      .prepare(
        `INSERT OR IGNORE INTO inbox_activities (activity_id, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(input.activityId, input.kind, JSON.stringify(input.payload), nowIso())
      .run();
  });
