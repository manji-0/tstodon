import { z } from "zod";
import { ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { parseRows, type RepositoryError, runD1 } from "./d1";
import { parseJsonColumn } from "./json-column";

const OwedRowSchema = z.object({
  kind: z.union([z.literal("Created"), z.literal("Edited")]),
  token: z.string().min(1),
  created_at: z.string().min(1),
  mentions_json: z.string(),
});

/**
 * The late work a stored remote note is still owed (`remote_status_owed`):
 * what runs after the batch that writes its row. `Created` is a note an inbox
 * activity stored: its mentions are notified and it is streamed as new.
 * `Edited` is an `Update` that changed its content: its boosters are notified
 * and the edit is streamed. `token` names the delivery that wrote the marker.
 * `mentions` are the local accounts an edit newly mentions, which only the
 * delivery that wrote the marker could tell; none for a `Created` marker.
 */
export type OwedMarker = Readonly<{
  kind: z.infer<typeof OwedRowSchema>["kind"];
  token: string;
  createdAt: string;
  mentions: ReadonlyArray<string>;
}>;

export const newOwedMarker = (
  kind: OwedMarker["kind"],
  mentions: ReadonlyArray<string> = [],
): OwedMarker => ({
  kind,
  token: crypto.randomUUID(),
  createdAt: nowIso(),
  mentions,
});

/**
 * The statement that writes `marker` for `statusId`, for the batch that
 * writes the status row. A marker of the same kind left by an earlier
 * delivery is replaced: its token, time and mentions become this delivery's.
 */
export const owedStatement = (
  db: D1Database,
  statusId: string,
  marker: OwedMarker,
): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO remote_status_owed (status_id, kind, token, created_at, mentions_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (status_id, kind) DO UPDATE
         SET token = excluded.token, created_at = excluded.created_at,
             mentions_json = excluded.mentions_json`,
    )
    .bind(statusId, marker.kind, marker.token, marker.createdAt, JSON.stringify(marker.mentions));

/** The markers of `statusId`: one per kind at most, none when nothing is owed. */
export const listOwed = (
  db: D1Database,
  statusId: string,
): Promise<Result<ReadonlyArray<OwedMarker>, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare(
        "SELECT kind, token, created_at, mentions_json FROM remote_status_owed WHERE status_id = ?",
      )
      .bind(statusId)
      .all();
    return parseRows(OwedRowSchema, rows.results).map((row) => ({
      kind: row.kind,
      token: row.token,
      createdAt: row.created_at,
      mentions: parseJsonColumn(z.array(z.string()), row.mentions_json).unwrapOr([]),
    }));
  });

/**
 * Delete the markers a delivery finished. A marker another delivery has
 * replaced since holds another token and stays: that delivery's work is not
 * this one's to call done.
 */
export const clearOwed = async (
  db: D1Database,
  statusId: string,
  markers: ReadonlyArray<OwedMarker>,
): Promise<Result<void, RepositoryError>> => {
  if (markers.length === 0) {
    return ok(undefined);
  }
  const cleared = await runD1(() =>
    db.batch(
      markers.map((marker) =>
        db
          .prepare("DELETE FROM remote_status_owed WHERE status_id = ? AND kind = ? AND token = ?")
          .bind(statusId, marker.kind, marker.token),
      ),
    ),
  );
  return cleared.map(() => undefined);
};

/**
 * How long a marker waits for the redelivery that finishes its work: a
 * sender retries a failed delivery for some days and then gives up. A week
 * is also the least the inbox keeps its dedupe rows
 * (`INBOX_ACTIVITY_RETENTION_DAYS`).
 */
export const OWED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete the markers older than {@link OWED_RETENTION_MS}: their sender gave
 * up, so the work they name stays undone. The counts of what was abandoned,
 * by marker kind.
 */
export const deleteAbandonedOwed = (
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<Result<Readonly<{ created: number; edited: number }>, RepositoryError>> =>
  runD1(async () => {
    const deleted = await db
      .prepare(
        "DELETE FROM remote_status_owed WHERE created_at < ? RETURNING kind, token, created_at, mentions_json",
      )
      .bind(new Date(nowMs - OWED_RETENTION_MS).toISOString())
      .all();
    const kinds = parseRows(OwedRowSchema, deleted.results).map((row) => row.kind);
    return {
      created: kinds.filter((kind) => kind === "Created").length,
      edited: kinds.filter((kind) => kind === "Edited").length,
    };
  });
