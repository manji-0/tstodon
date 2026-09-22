import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import { parseRow } from "./schemas";

export const MarkerTimelineSchema = z.union([z.literal("home"), z.literal("notifications")]);
export type MarkerTimeline = z.infer<typeof MarkerTimelineSchema>;

const MarkerRowSchema = z.object({
  account_id: z.string().min(1),
  timeline: MarkerTimelineSchema,
  last_read_id: z.string().min(1),
  version: z.number(),
  updated_at: z.string().min(1),
});

export type MarkerDocument = Readonly<{
  last_read_id: string;
  version: number;
  updated_at: string;
}>;

export const getMarkers = async (
  db: D1Database,
  accountId: string,
  timelines: ReadonlyArray<MarkerTimeline>,
): Promise<Result<Readonly<Record<string, MarkerDocument>>, RepositoryError>> => {
  if (timelines.length === 0) {
    return ok({});
  }
  return runD1(async () => {
    const placeholders = timelines.map(() => "?").join(", ");
    const { results } = await db
      .prepare(
        `SELECT account_id, timeline, last_read_id, version, updated_at
         FROM markers
         WHERE account_id = ? AND timeline IN (${placeholders})`,
      )
      .bind(accountId, ...timelines)
      .all();
    const markers: Record<string, MarkerDocument> = {};
    for (const raw of results ?? []) {
      const row = parseRow(MarkerRowSchema, raw);
      if (row.isErr()) {
        continue;
      }
      markers[row.value.timeline] = {
        last_read_id: row.value.last_read_id,
        version: row.value.version,
        updated_at: row.value.updated_at,
      };
    }
    return markers;
  });
};

export const upsertMarkers = async (
  db: D1Database,
  accountId: string,
  patches: ReadonlyArray<Readonly<{ timeline: MarkerTimeline; last_read_id: string }>>,
): Promise<Result<Readonly<Record<string, MarkerDocument>>, RepositoryError>> => {
  if (patches.length === 0) {
    return ok({});
  }
  const updatedAt = nowIso();
  for (const patch of patches) {
    const written = await runD1(async () => {
      await db
        .prepare(
          `INSERT INTO markers (account_id, timeline, last_read_id, version, updated_at)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(account_id, timeline) DO UPDATE SET
             last_read_id = excluded.last_read_id,
             version = markers.version + 1,
             updated_at = excluded.updated_at`,
        )
        .bind(accountId, patch.timeline, patch.last_read_id, updatedAt)
        .run();
    });
    if (written.isErr()) {
      return err(written.error);
    }
  }
  return getMarkers(
    db,
    accountId,
    patches.map((patch) => patch.timeline),
  );
};

export const markConversationRead = async (
  db: D1Database,
  accountId: string,
  conversationId: string,
  lastReadStatusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `INSERT INTO conversation_reads (account_id, conversation_id, last_read_status_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, conversation_id) DO UPDATE SET
           last_read_status_id = excluded.last_read_status_id,
           updated_at = excluded.updated_at`,
      )
      .bind(accountId, conversationId, lastReadStatusId, nowIso())
      .run();
  });

export const getConversationRead = async (
  db: D1Database,
  accountId: string,
  conversationId: string,
): Promise<Result<string | undefined, RepositoryError>> => {
  const queried = await runD1(() =>
    db
      .prepare(
        `SELECT last_read_status_id FROM conversation_reads
         WHERE account_id = ? AND conversation_id = ?`,
      )
      .bind(accountId, conversationId)
      .first<{ last_read_status_id: string }>(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(queried.value?.last_read_status_id);
};

export const parseMarkerTimelines = (raw: unknown): MarkerTimeline[] => {
  const values = Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw];
  const timelines: MarkerTimeline[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const parsed = MarkerTimelineSchema.safeParse(value);
    if (parsed.success) {
      timelines.push(parsed.data);
    }
  }
  return timelines;
};

export const markerBodySchema = z.object({
  home: z.object({ last_read_id: z.string().min(1) }).optional(),
  notifications: z.object({ last_read_id: z.string().min(1) }).optional(),
});
