import { compileSchema, warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { runD1, runD1Batch, type RepositoryError } from "./d1";
import { parseRow } from "./schemas";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import {
  getConversationRead as getConversationReadSql,
  getMarkersByTimelines as getMarkersByTimelinesSql,
  upsertConversationRead as upsertConversationReadSql,
  upsertMarker as upsertMarkerSql,
} from "./generated/prisma/sql";

export const MarkerTimelineSchema = z.union([z.literal("home"), z.literal("notifications")]);
export type MarkerTimeline = z.infer<typeof MarkerTimelineSchema>;

const compiledMarkerTimelineSchema = compileSchema(MarkerTimelineSchema);

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
  // At most two timelines exist; pad the fixed-arity TypedSQL IN list.
  const timelineA = timelines[0] ?? "home";
  const timelineB = timelines[1] ?? timelineA;
  return runD1(async () => {
    const results = await queryTyped(db, getMarkersByTimelinesSql(accountId, timelineA, timelineB));
    const markers: Record<string, MarkerDocument> = {};
    for (const raw of results) {
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
  const batched = await runD1Batch(
    db,
    patches.map((patch) =>
      d1PrepareTyped(db, upsertMarkerSql(accountId, patch.timeline, patch.last_read_id, updatedAt)),
    ),
  );
  if (batched.isErr()) {
    return err(batched.error);
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
    await runTyped(
      db,
      upsertConversationReadSql(accountId, conversationId, lastReadStatusId, nowIso()),
    );
  });

export const getConversationRead = async (
  db: D1Database,
  accountId: string,
  conversationId: string,
): Promise<Result<string | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    return queryTyped<{ last_read_status_id: string }>(
      db,
      getConversationReadSql(accountId, conversationId),
    );
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(queried.value[0]?.last_read_status_id);
};

export const parseMarkerTimelines = (raw: unknown): MarkerTimeline[] => {
  const values = Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw];
  const timelines: MarkerTimeline[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const parsed = compiledMarkerTimelineSchema.safeParse(value);
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

warmSchemas([MarkerTimelineSchema, MarkerRowSchema, markerBodySchema]);
