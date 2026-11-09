import { ApiStatusEdit, type ApiStatusJSON } from "@tstodon/api";
import { z } from "zod";
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
import { parseJsonColumn } from "./json-column";

/**
 * One replaced revision of a local status, as `status_edits.snapshot_json`
 * keeps it: the `StatusEdit` entity without its `account`, which history
 * renders as the author is now. `created_at` is when the revision was made.
 * Rows written before this shape hold the whole `Status` document of the
 * revision; they parse the same way (the other fields are dropped, a poll
 * keeps its option titles).
 */
export const StatusEditSnapshot = ApiStatusEdit.omit({ account: true });
export type StatusEditSnapshot = z.infer<typeof StatusEditSnapshot>;

const SnapshotJsonRow = z.object({ snapshot_json: z.string() });
const UpdatedAtRow = z.object({ updated_at: z.string() });

/** Store the previous revision of a status as a history snapshot. */
export const insertStatusEdit = async (
  db: D1Database,
  statusId: string,
  snapshot: StatusEditSnapshot,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      insertStatusEditSql(newEntityId(), statusId, JSON.stringify(snapshot), nowIso()),
    );
  });

/** Previous revisions, newest first. A row that does not parse is left out. */
export const listStatusEdits = async (
  db: D1Database,
  statusId: string,
): Promise<Result<StatusEditSnapshot[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listStatusEditSnapshotsSql(statusId), SnapshotJsonRow);
    return rows.flatMap((row) => {
      const parsed = parseJsonColumn(StatusEditSnapshot, row.snapshot_json);
      return parsed.isOk() ? [parsed.value] : [];
    });
  });

/** A status document as the snapshot of one revision, made at `createdAt`. */
export const statusEditSnapshotOf = (
  status: Pick<
    ApiStatusJSON,
    "content" | "spoiler_text" | "sensitive" | "media_attachments" | "emojis" | "poll"
  >,
  createdAt: string,
): StatusEditSnapshot => ({
  content: status.content,
  spoiler_text: status.spoiler_text,
  sensitive: status.sensitive,
  created_at: createdAt,
  poll: status.poll ? { options: status.poll.options.map(({ title }) => ({ title })) } : null,
  media_attachments: status.media_attachments,
  emojis: status.emojis,
});

export const findStatusUpdatedAt = async (
  db: D1Database,
  statusId: string,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findStatusUpdatedAtSql(statusId), UpdatedAtRow);
    return rows[0]?.updated_at;
  });
