import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  type AnnouncementInput,
  type AnnouncementRow,
  deleteAnnouncementById,
  findAnnouncementRowById,
  insertAnnouncement,
  listAdminAnnouncements,
  setAnnouncementPublished,
  updateAnnouncement,
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

export const adminAnnouncementRoutes = new Hono<{ Bindings: Env }>();

const AnnouncementBodySchema = z.object({
  text: z.string().optional(),
  content: z.string().optional(),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  all_day: z.union([z.boolean(), z.string(), z.number()]).optional(),
  scheduled_at: z.string().nullable().optional(),
});

const escapeHtmlText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const announcementContent = (body: z.infer<typeof AnnouncementBodySchema>): string | undefined => {
  if (typeof body.content === "string" && body.content.trim().length > 0) {
    return body.content;
  }
  if (typeof body.text === "string") {
    return `<p>${escapeHtmlText(body.text.trim())}</p>`;
  }
  return undefined;
};

/** `null` passes through (clears); a missing value inherits `fallback`. */
const dateField = (
  value: string | null | undefined,
  fallback: string | null,
): string | null | undefined => {
  if (value === undefined) {
    return fallback;
  }
  if (value === null || value.length === 0) {
    return null;
  }
  return Number.isFinite(Date.parse(value)) ? value : undefined;
};

const scheduledPublishedAt = (scheduledAt: string | null): string | undefined => {
  if (scheduledAt === null || scheduledAt.length === 0) {
    return nowIso();
  }
  const parsed = Date.parse(scheduledAt);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed > Date.now() ? new Date(parsed).toISOString() : nowIso();
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

adminAnnouncementRoutes.get("/api/v1/admin/announcements", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const rows = await listAdminAnnouncements(c.env.DB);
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  return c.json(rows.value.map(adminAnnouncementDocument));
});

adminAnnouncementRoutes.post("/api/v1/admin/announcements", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readBody(c, AnnouncementBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const content = announcementContent(body.value);
  if (content === undefined) {
    return validation(c, "text is required");
  }
  const startsAt = dateField(body.value.starts_at, null);
  const endsAt = dateField(body.value.ends_at, null);
  if (startsAt === undefined || endsAt === undefined) {
    return validation(c, "starts_at and ends_at must be ISO 8601 datetimes");
  }
  const publishedAt = scheduledPublishedAt(body.value.scheduled_at ?? nowIso());
  if (publishedAt === undefined) {
    return validation(c, "scheduled_at must be an ISO 8601 datetime");
  }
  const input: AnnouncementInput = {
    content,
    startsAt,
    endsAt,
    allDay: parseBool(body.value.all_day, false),
    publishedAt,
  };
  const created = await insertAnnouncement(c.env.DB, input);
  if (created.isErr()) {
    return jsonRepositoryError(c, created.error.message);
  }
  const row = await findAnnouncementRowById(c.env.DB, created.value);
  if (row.isErr() || !row.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(adminAnnouncementDocument(row.value));
});

adminAnnouncementRoutes.put("/api/v1/admin/announcements/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const id = c.req.param("id") ?? "";
  const existing = await findAnnouncementRowById(c.env.DB, id);
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  if (!existing.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const body = await readBody(c, AnnouncementBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const content = announcementContent(body.value) ?? existing.value.content;
  const startsAt = dateField(body.value.starts_at, existing.value.starts_at);
  const endsAt = dateField(body.value.ends_at, existing.value.ends_at);
  if (startsAt === undefined || endsAt === undefined) {
    return validation(c, "starts_at and ends_at must be ISO 8601 datetimes");
  }
  const scheduled =
    body.value.scheduled_at === undefined
      ? existing.value.published_at
      : scheduledPublishedAt(body.value.scheduled_at);
  if (scheduled === undefined) {
    return validation(c, "scheduled_at must be an ISO 8601 datetime");
  }
  const updated = await updateAnnouncement(c.env.DB, id, {
    content,
    startsAt,
    endsAt,
    allDay:
      body.value.all_day === undefined
        ? existing.value.all_day !== 0
        : parseBool(body.value.all_day, false),
    publishedAt: scheduled,
  });
  if (updated.isErr()) {
    return jsonRepositoryError(c, updated.error.message);
  }
  const row = await findAnnouncementRowById(c.env.DB, id);
  if (row.isErr() || !row.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(adminAnnouncementDocument(row.value));
});

adminAnnouncementRoutes.delete("/api/v1/admin/announcements/:id", async (c) => {
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
});

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

adminAnnouncementRoutes.post("/api/v1/admin/announcements/:id/publish", (c) =>
  setAnnouncementPublication(c, true),
);
adminAnnouncementRoutes.post("/api/v1/admin/announcements/:id/unpublish", (c) =>
  setAnnouncementPublication(c, false),
);

/**
 * Mastodon translates the admin account query parameters into a single
 * origin/status pair: local and active by default, `remote=true` switching the
 * origin, and one of the boolean status flags (last one wins in Mastodon's
 * order) switching the status.
 */
