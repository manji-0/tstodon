import type { ApiMediaAttachmentJSON, ApiScheduledStatusJSON } from "@tstodon/api";
import type { InstanceIdentity } from "@tstodon/domain";
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
  type ScheduledStatusRow,
  updateScheduledStatusAt,
} from "../scheduled-status-store";

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

/**
 * The media a scheduled post will attach, in its order. Only the author's own
 * media counts: rows stored before `media_ids` was checked can name any.
 */
export const scheduledStatusMedia = async (
  db: D1Database,
  identity: InstanceIdentity,
  row: ScheduledStatusRow,
): Promise<ApiMediaAttachmentJSON[]> => {
  if (row.params.media_ids.length === 0) {
    return [];
  }
  const media = await findMediaByIds(db, [...row.params.media_ids]);
  if (media.isErr()) {
    return [];
  }
  return row.params.media_ids.flatMap((id) => {
    const attachment = media.value.get(id);
    return attachment && attachment.account_id === row.accountId
      ? [mastodonMedia(identity, attachment)]
      : [];
  });
};

const scheduledDocument = async (
  c: Context<{ Bindings: Env }>,
  row: ScheduledStatusRow,
): Promise<ApiScheduledStatusJSON | undefined> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return undefined;
  }
  return scheduledStatusDocument(row, await scheduledStatusMedia(c.env.DB, identity.value, row));
};

const notFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

export const getV1ScheduledStatuses = async (
  c: Context<{ Bindings: Env }, "/api/v1/scheduled_statuses">,
) => {
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
  const documents: ApiScheduledStatusJSON[] = [];
  for (const row of rows.value) {
    const document = await scheduledDocument(c, row);
    if (document) {
      documents.push(document);
    }
  }
  return c.json(documents);
};

export const getV1ScheduledStatusesById = async (
  c: Context<{ Bindings: Env }, "/api/v1/scheduled_statuses/:id">,
) => {
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
};

export const putV1ScheduledStatusesById = async (
  c: Context<{ Bindings: Env }, "/api/v1/scheduled_statuses/:id">,
) => {
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
};

export const deleteV1ScheduledStatusesById = async (
  c: Context<{ Bindings: Env }, "/api/v1/scheduled_statuses/:id">,
) => {
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
  return c.json({});
};
