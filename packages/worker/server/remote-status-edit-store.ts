import { z } from "zod";
import type { Result } from "neverthrow";
import { nowIso } from "./clock";
import { type RepositoryError, runD1 } from "./d1";
import {
  insertRemoteStatusEdit as insertRemoteStatusEditSql,
  listRemoteStatusEditSnapshots as listRemoteStatusEditSnapshotsSql,
} from "./generated/prisma/sql";
import { newEntityId } from "./ids";
import { queryTyped, runTyped } from "./typed-sql";

const SnapshotJsonRow = z.object({ snapshot_json: z.string() });

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
    const rows = await queryTyped(db, listRemoteStatusEditSnapshotsSql(statusId), SnapshotJsonRow);
    return rows.map((row) => row.snapshot_json);
  });
