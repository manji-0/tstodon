import type { Context } from "hono";
import type { Result } from "neverthrow";
import { z } from "zod";
import {
  ANNOUNCEMENT_ERRORS,
  type AnnouncementDraft,
  type AnnouncementError,
  changeAnnouncement,
  createAnnouncement,
} from "../../admin-announcements";
import {
  type AnnouncementRow,
  deleteAnnouncementById,
  findAnnouncementRowById,
  listAdminAnnouncements,
  setAnnouncementPublished,
} from "../../announcement-admin-store";
import { nowIso } from "../../clock";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readBody,
  requireAdmin,
} from "../../http";
import { parseBool, validation } from "./shared";

const AnnouncementBodySchema = z.object({
  text: z.string().optional(),
  content: z.string().optional(),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  all_day: z.union([z.boolean(), z.string(), z.number()]).optional(),
  scheduled_at: z.string().nullable().optional(),
});

const draftOf = (body: z.infer<typeof AnnouncementBodySchema>): AnnouncementDraft => ({
  text: body.text,
  content: body.content,
  startsAt: body.starts_at,
  endsAt: body.ends_at,
  allDay: body.all_day === undefined ? undefined : parseBool(body.all_day, false),
  scheduledAt: body.scheduled_at,
});

const announcementResponse = (
  c: Context<{ Bindings: Env }>,
  saved: Result<AnnouncementRow, AnnouncementError>,
): Response => {
  if (saved.isOk()) {
    return c.json(adminAnnouncementDocument(saved.value));
  }
  switch (saved.error.kind) {
    case "NotFound":
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    case "RepositoryError":
      return jsonRepositoryError(c, saved.error.message);
    case "TextRequired":
    case "InvalidWindow":
    case "InvalidSchedule":
      return validation(c, ANNOUNCEMENT_ERRORS[saved.error.kind]);
  }
};

const adminAnnouncementDocument = (row: AnnouncementRow): Record<string, unknown> => ({
  id: row.id,
  text: row.content,
  content: row.content,
  starts_at: row.starts_at,
  ends_at: row.ends_at,
  all_day: row.all_day !== 0,
  published_at: row.published_at,
  created_at: row.created_at,
  updated_at: row.updated_at,
  mentions: [],
  statuses: [],
  tags: [],
  emojis: [],
  reactions: [],
});

export const getV1AdminAnnouncements = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/announcements">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const rows = await listAdminAnnouncements(c.env.DB);
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  return c.json(rows.value.map(adminAnnouncementDocument));
};

export const postV1AdminAnnouncements = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/announcements">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readBody(c, AnnouncementBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const created = await createAnnouncement(c.env.DB, draftOf(body.value));
  return announcementResponse(c, created);
};

export const putV1AdminAnnouncementsById = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/announcements/:id">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readBody(c, AnnouncementBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const changed = await changeAnnouncement(c.env.DB, c.req.param("id") ?? "", draftOf(body.value));
  return announcementResponse(c, changed);
};

export const deleteV1AdminAnnouncementsById = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/announcements/:id">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const removed = await deleteAnnouncementById(c.env.DB, c.req.param("id") ?? "");
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  if (!removed.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({});
};

const setAnnouncementPublication = async (
  c: Context<{ Bindings: Env }>,
  published: boolean,
): Promise<Response> => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const id = c.req.param("id") ?? "";
  const changed = await setAnnouncementPublished(c.env.DB, id, published ? nowIso() : null);
  if (changed.isErr()) {
    return jsonRepositoryError(c, changed.error.message);
  }
  if (!changed.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const row = await findAnnouncementRowById(c.env.DB, id);
  if (row.isErr() || !row.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(adminAnnouncementDocument(row.value));
};

export const postV1AdminAnnouncementsByIdPublish = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/announcements/:id/publish">,
) => setAnnouncementPublication(c, true);
export const postV1AdminAnnouncementsByIdUnpublish = (
  c: Context<{ Bindings: Env }, "/api/v1/admin/announcements/:id/unpublish">,
) => setAnnouncementPublication(c, false);

/**
 * Mastodon translates the admin account query parameters into a single
 * origin/status pair: local and active by default, `remote=true` switching the
 * origin, and one of the boolean status flags (last one wins in Mastodon's
 * order) switching the status.
 */
