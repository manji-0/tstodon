import type { Result } from "neverthrow";
import { nowIso } from "./clock";
import { type RepositoryError, runD1 } from "./d1";
import { newEntityId } from "./ids";
import { queryTyped, runTyped } from "./typed-sql";
import {
  findStatusUpdatedAt as findStatusUpdatedAtSql,
  insertStatusEdit as insertStatusEditSql,
  listStatusEditSnapshots as listStatusEditSnapshotsSql,
} from "./generated/prisma/sql";

/** Store the previous revision of a status as a history snapshot. */
export const insertStatusEdit = async (
  db: D1Database,
  statusId: string,
  snapshotJson: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, insertStatusEditSql(newEntityId(), statusId, snapshotJson, nowIso()));
  });

/** Previous revisions, newest first. */
export const listStatusEdits = async (
  db: D1Database,
  statusId: string,
): Promise<Result<Record<string, unknown>[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ snapshot_json: string }>(
      db,
      listStatusEditSnapshotsSql(statusId),
    );
    const snapshots: Record<string, unknown>[] = [];
    for (const row of rows) {
      const parsed: unknown = JSON.parse(row.snapshot_json);
      if (parsed !== null && typeof parsed === "object") {
        snapshots.push({ ...parsed });
      }
    }
    return snapshots;
  });

export const findStatusUpdatedAt = async (
  db: D1Database,
  statusId: string,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ updated_at: string }>(db, findStatusUpdatedAtSql(statusId));
    return rows[0]?.updated_at;
  });
