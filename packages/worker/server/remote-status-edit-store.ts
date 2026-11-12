import { z } from "zod";
import type { Result } from "neverthrow";
import { nowIso } from "./clock";
import { type RepositoryError, runD1 } from "./d1";
import {
  insertRemoteStatusEdit as insertRemoteStatusEditSql,
  listRemoteStatusEditSnapshots as listRemoteStatusEditSnapshotsSql,
} from "./generated/prisma/sql";
import { newEntityId } from "./ids";
import { d1PrepareTyped, queryTyped } from "./typed-sql";

const SnapshotJsonRow = z.object({ snapshot_json: z.string() });

/**
 * The statement that keeps the version of a remote note an `Update` is about
 * to replace. `editedAt` is that version's (`null`: never edited). When the
 * row holds another version by then, the statement fails, and so does the
 * batch it runs in.
 */
export const remoteStatusEditStatement = (
  db: D1Database,
  statusId: string,
  snapshotJson: string,
  editedAt: string | null,
): D1PreparedStatement =>
  d1PrepareTyped(
    db,
    insertRemoteStatusEditSql(newEntityId(), statusId, snapshotJson, nowIso(), editedAt),
  );

/** Replaced versions as stored JSON text, newest first. */
export const listRemoteStatusEdits = async (
  db: D1Database,
  statusId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listRemoteStatusEditSnapshotsSql(statusId), SnapshotJsonRow);
    return rows.map((row) => row.snapshot_json);
  });
