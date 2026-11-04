import type { Result } from "neverthrow";
import { nowIso } from "./clock";
import { type RepositoryError, runD1 } from "./d1";
import {
  insertRemoteStatusEdit as insertRemoteStatusEditSql,
  listRemoteStatusEditSnapshots as listRemoteStatusEditSnapshotsSql,
} from "./generated/prisma/sql";
import { newEntityId } from "./ids";
import { queryTyped, runTyped } from "./typed-sql";

/** Keep the version of a remote note an `Update` is about to replace. */
export const insertRemoteStatusEdit = async (
  db: D1Database,
  statusId: string,
  snapshotJson: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, insertRemoteStatusEditSql(newEntityId(), statusId, snapshotJson, nowIso()));
  });

/** Replaced versions as stored JSON text, newest first. */
export const listRemoteStatusEdits = async (
  db: D1Database,
  statusId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ snapshot_json: string }>(
      db,
      listRemoteStatusEditSnapshotsSql(statusId),
    );
    return rows.map((row) => row.snapshot_json);
  });
