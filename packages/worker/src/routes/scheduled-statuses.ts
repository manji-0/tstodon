import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { findMediaByIds } from "../media-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  queryCursor,
  queryLimit,
  readBody,
  requireUser,
} from "../http";
import { mastodonMedia } from "../media-document";
import { parseInstanceIdentity } from "../runtime-config";
import {
  MIN_SCHEDULE_OFFSET_MS,
  deleteScheduledStatus,
  findScheduledStatus,
  listScheduledStatuses,
  scheduledStatusDocument,
  updateScheduledStatusAt,
} from "../scheduled-status-store";

export const scheduledStatusRoutes = new Hono<{ Bindings: Env }>();

/** `PUT /api/v1/scheduled_statuses/:id` — reschedule only. */
const RescheduleBodySchema = z.object({ scheduled_at: z.string().optional() });

/** A schedule must stay at least five minutes away, as Mastodon requires. */
const parseScheduledAt = (raw: string): string | undefined => {
  const at = Date.parse(raw);
  if (!Number.isFinite(at) || at < Date.now() + MIN_SCHEDULE_OFFSET_MS) {
    return undefined;
  }
  return new Date(at).toISOString();
};

const scheduledDocument = async (
  c: Context<{ Bindings: Env }>,
  row: Parameters<typeof scheduledStatusDocument>[0],
): Promise<Record<string, unknown> | undefined> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return undefined;
  }
  const media =
    row.params.media_ids.length > 0
      ? await findMediaByIds(c.env.DB, [...row.params.media_ids])
      : undefined;
  const attachments =
    media && media.isOk()
      ? [...media.value.values()].map((attachment) => mastodonMedia(identity.value, attachment))
      : [];
  return scheduledStatusDocument(row, attachments);
};

const notFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

scheduledStatusRoutes.get("/api/v1/scheduled_statuses", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  // Mastodon: 20 by default, max 40.
  const rows = await listScheduledStatuses(
    c.env.DB,
    user.value.id,
    queryLimit(c.req.query("limit"), 20),
    queryCursor(c),
  );
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  const documents: Record<string, unknown>[] = [];
  for (const row of rows.value) {
    const document = await scheduledDocument(c, row);
    if (document) {
      documents.push(document);
    }
  }
  return c.json(documents);
});

scheduledStatusRoutes.get("/api/v1/scheduled_statuses/:id", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const row = await findScheduledStatus(c.env.DB, user.value.id, c.req.param("id") ?? "");
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value) {
    return notFound(c);
  }
  const document = await scheduledDocument(c, row.value);
  return document ? c.json(document) : notFound(c);
});

scheduledStatusRoutes.put("/api/v1/scheduled_statuses/:id", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readBody(c, RescheduleBodySchema);
  if (body.isErr()) {
    return c.json(
      { error: "Validation failed: Scheduled at is invalid", kind: "ValidationError" },
      422,
    );
  }
  const scheduledAt = parseScheduledAt(body.value.scheduled_at ?? "");
  if (scheduledAt === undefined) {
    return c.json(
      {
        error: "scheduled_at must be at least 5 minutes in the future",
        kind: "InvalidScheduledAt",
      },
      422,
    );
  }
  const updated = await updateScheduledStatusAt(
    c.env.DB,
    user.value.id,
    c.req.param("id") ?? "",
    scheduledAt,
  );
  if (updated.isErr()) {
    return jsonRepositoryError(c, updated.error.message);
  }
  if (!updated.value) {
    return notFound(c);
  }
  const row = await findScheduledStatus(c.env.DB, user.value.id, c.req.param("id") ?? "");
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value) {
    return notFound(c);
  }
  const document = await scheduledDocument(c, row.value);
  return document ? c.json(document) : notFound(c);
});

scheduledStatusRoutes.delete("/api/v1/scheduled_statuses/:id", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const removed = await deleteScheduledStatus(c.env.DB, user.value.id, c.req.param("id") ?? "");
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  if (!removed.value) {
    return notFound(c);
  }
  return c.body(null, 200);
});
