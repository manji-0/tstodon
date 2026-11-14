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

/**
 * How long a delivery holds the late steps of a marker. It is also the
 * `Retry-After` of a delivery that did not get them: a holder that was cut
 * off has lost them by the time that delivery comes again.
 */
export const OWED_LEASE_SECONDS = 60;

/**
 * A marker whose late steps this delivery runs, and no other until
 * `heldUntil` (`claimed_until`): it wrote the marker, or took the lease of
 * one that nobody held ({@link claimOwed}).
 */
export type HeldOwed = OwedMarker & Readonly<{ heldUntil: string }>;

/**
 * Another delivery holds the late steps of the note this one carries, and
 * this one cannot answer for them: the sender is asked to deliver again.
 */
export type LateStepsInFlight = Readonly<{ kind: "LateStepsInFlight" }>;

const leaseEnd = (nowMs: number): string =>
  new Date(nowMs + OWED_LEASE_SECONDS * 1000).toISOString();

export const newOwedMarker = (
  kind: OwedMarker["kind"],
  mentions: ReadonlyArray<string> = [],
): HeldOwed => ({
  kind,
  token: crypto.randomUUID(),
  createdAt: nowIso(),
  mentions,
  heldUntil: leaseEnd(Date.now()),
});

/**
 * The statement that writes `marker` for `statusId`, for the batch that
 * writes the status row. A marker of the same kind left by an earlier
 * delivery is replaced: its token, time, mentions and lease become this
 * delivery's.
 */
export const owedStatement = (
  db: D1Database,
  statusId: string,
  marker: HeldOwed,
): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO remote_status_owed
         (status_id, kind, token, created_at, mentions_json, claimed_until)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (status_id, kind) DO UPDATE
         SET token = excluded.token, created_at = excluded.created_at,
             mentions_json = excluded.mentions_json, claimed_until = excluded.claimed_until`,
    )
    .bind(
      statusId,
      marker.kind,
      marker.token,
      marker.createdAt,
      JSON.stringify(marker.mentions),
      marker.heldUntil,
    );

/**
 * Take the late steps of `marker`, which another delivery wrote, for this
 * one. `undefined` when a delivery holds them now, or the marker is gone or
 * replaced: they are not this delivery's to run. The check and the write are
 * one statement, so of two deliveries that find the marker at the same
 * moment one runs the steps. A lease that is past was a delivery's that was
 * cut off, and is taken over.
 */
export const claimOwed = (
  db: D1Database,
  statusId: string,
  marker: OwedMarker,
  nowMs: number = Date.now(),
): Promise<Result<HeldOwed | undefined, RepositoryError>> =>
  runD1(async () => {
    const heldUntil = leaseEnd(nowMs);
    const claimed = await db
      .prepare(
        `UPDATE remote_status_owed SET claimed_until = ?
         WHERE status_id = ? AND kind = ? AND token = ?
           AND (claimed_until IS NULL OR claimed_until < ?)
         RETURNING token`,
      )
      .bind(heldUntil, statusId, marker.kind, marker.token, new Date(nowMs).toISOString())
      .all();
    return claimed.results.length > 0 ? { ...marker, heldUntil } : undefined;
  });

/**
 * Give up the late steps of `held` without finishing them, so the next
 * delivery of the note takes them at once. A lease another delivery has
 * taken over since, or a marker that was replaced, is left as it is.
 */
export const releaseOwed = (
  db: D1Database,
  statusId: string,
  held: HeldOwed,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `UPDATE remote_status_owed SET claimed_until = NULL
         WHERE status_id = ? AND kind = ? AND token = ? AND claimed_until = ?`,
      )
      .bind(statusId, held.kind, held.token, held.heldUntil)
      .run();
  });

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
