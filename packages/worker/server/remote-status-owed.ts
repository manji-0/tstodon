import { z } from "zod";
import { ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { parseRows, type RepositoryError, runD1 } from "./d1";

const OwedRowSchema = z.object({
  kind: z.union([z.literal("Created"), z.literal("Edited")]),
  token: z.string().min(1),
  created_at: z.string().min(1),
});

/**
 * The late work a stored remote note is still owed (`remote_status_owed`):
 * what runs after the batch that writes its row. `Created` is a note an inbox
 * activity stored: its mentions are notified and it is streamed as new.
 * `Edited` is an `Update` that changed its content: its boosters are notified
 * and the edit is streamed. `token` names the delivery that wrote the marker.
 */
export type OwedMarker = Readonly<{
  kind: z.infer<typeof OwedRowSchema>["kind"];
  token: string;
  createdAt: string;
}>;

export const newOwedMarker = (kind: OwedMarker["kind"]): OwedMarker => ({
  kind,
  token: crypto.randomUUID(),
  createdAt: nowIso(),
});

/**
 * The statement that writes `marker` for `statusId`, for the batch that
 * writes the status row. A marker of the same kind left by an earlier
 * delivery is replaced: its token and time become this delivery's.
 */
export const owedStatement = (
  db: D1Database,
  statusId: string,
  marker: OwedMarker,
): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO remote_status_owed (status_id, kind, token, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (status_id, kind) DO UPDATE
         SET token = excluded.token, created_at = excluded.created_at`,
    )
    .bind(statusId, marker.kind, marker.token, marker.createdAt);

/** The markers of `statusId`: one per kind at most, none when nothing is owed. */
export const listOwed = (
  db: D1Database,
  statusId: string,
): Promise<Result<ReadonlyArray<OwedMarker>, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare("SELECT kind, token, created_at FROM remote_status_owed WHERE status_id = ?")
      .bind(statusId)
      .all();
    return parseRows(OwedRowSchema, rows.results).map((row) => ({
      kind: row.kind,
      token: row.token,
      createdAt: row.created_at,
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
