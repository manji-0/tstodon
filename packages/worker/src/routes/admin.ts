import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { InstanceIdentity, LocalAccount } from "@tstodon/domain";
import {
  deleteAnnouncementById,
  findAnnouncementRowById,
  insertAnnouncement,
  listAdminAnnouncements,
  setAnnouncementPublished,
  updateAnnouncement,
  type AnnouncementInput,
  type AnnouncementRow,
} from "../announcement-admin-store";
import {
  adminCustomEmojiJson,
  deleteCustomEmoji,
  findCustomEmojiRowById,
  findCustomEmojiRowByShortcode,
  insertCustomEmoji,
  isValidShortcode,
  listCustomEmojiRows,
  loadCustomEmojis,
  normalizeShortcode,
  replaceCustomEmojiImage,
  updateCustomEmojiAttributes,
} from "../custom-emoji-store";
import { nowIso } from "../clock";
import {
  listAccountModerations,
  setAccountModeration,
  type AccountModeration,
} from "../account-moderation-store";
import { findAccountById, listAdminAccounts } from "../account-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryLimit,
  readBody,
  requireAdmin,
} from "../http";
import { newEntityId } from "../ids";
import { mastodonAccountDocument } from "../mastodon";
import { parseInstanceIdentity } from "../runtime-config";

export const adminRoutes = new Hono<{ Bindings: Env }>();

const parseBool = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value === "true" || value === "1") {
      return true;
    }
    if (value === "false" || value === "0") {
      return false;
    }
  }
  return fallback;
};

const optionalCategory = (value: unknown): string | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const fileFrom = (value: unknown): File | undefined =>
  typeof File !== "undefined" && value instanceof File && value.size > 0 ? value : undefined;

const validation = (c: Context<{ Bindings: Env }>, message: string): Response =>
  c.json({ error: message, kind: "ValidationError" }, 422);

adminRoutes.get("/api/v1/admin/custom_emojis", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const rows = await listCustomEmojiRows(c.env.DB);
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  return c.json(
    rows.value.map((row) => adminCustomEmojiJson(row, identity.value.mediaPublicBaseUrl)),
  );
});

adminRoutes.post("/api/v1/admin/custom_emojis", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await c.req.parseBody();
  const shortcode = normalizeShortcode(typeof body.shortcode === "string" ? body.shortcode : "");
  if (!isValidShortcode(shortcode)) {
    return validation(c, "shortcode is invalid");
  }
  const image = fileFrom(body.image);
  if (!image) {
    return validation(c, "image is required");
  }
  const existing = await findCustomEmojiRowByShortcode(c.env.DB, shortcode);
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  const configured = await loadCustomEmojis(c.env, identity.value.mediaPublicBaseUrl);
  if (existing.value || configured.some((emoji) => emoji.shortcode.toLowerCase() === shortcode)) {
    return validation(c, "shortcode has already been taken");
  }

  const id = newEntityId();
  const objectKey = `emoji/${id}`;
  const contentType = image.type.length > 0 ? image.type : "application/octet-stream";
  await c.env.MEDIA.put(objectKey, await image.arrayBuffer(), {
    httpMetadata: { contentType },
  });
  const inserted = await insertCustomEmoji(c.env.DB, {
    id,
    shortcode,
    objectKey,
    contentType,
    visibleInPicker: parseBool(body.visible_in_picker, true),
    category: optionalCategory(body.category) ?? null,
  });
  if (inserted.isErr()) {
    return jsonRepositoryError(c, inserted.error.message);
  }
  const row = await findCustomEmojiRowById(c.env.DB, id);
  if (row.isErr() || !row.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(adminCustomEmojiJson(row.value, identity.value.mediaPublicBaseUrl));
});

adminRoutes.patch("/api/v1/admin/custom_emojis/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const id = c.req.param("id") ?? "";
  const row = await findCustomEmojiRowById(c.env.DB, id);
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }

  let visibleInPicker: boolean | undefined;
  let category: string | null | undefined;
  let image: File | undefined;
  if ((c.req.header("content-type") ?? "").includes("application/json")) {
    const body = await c.req.json<Record<string, unknown>>();
    if (body.visible_in_picker !== undefined) {
      visibleInPicker = parseBool(body.visible_in_picker, row.value.visible_in_picker !== 0);
    }
    category = optionalCategory(body.category);
  } else {
    const body = await c.req.parseBody();
    if (body.visible_in_picker !== undefined) {
      visibleInPicker = parseBool(body.visible_in_picker, row.value.visible_in_picker !== 0);
    }
    category = optionalCategory(body.category);
    image = fileFrom(body.image);
  }

  if (visibleInPicker !== undefined || category !== undefined) {
    const updated = await updateCustomEmojiAttributes(
      c.env.DB,
      id,
      visibleInPicker ?? row.value.visible_in_picker !== 0,
      category !== undefined ? category : row.value.category,
    );
    if (updated.isErr()) {
      return jsonRepositoryError(c, updated.error.message);
    }
  }
  if (image) {
    const contentType = image.type.length > 0 ? image.type : "application/octet-stream";
    await c.env.MEDIA.put(`emoji/${id}`, await image.arrayBuffer(), {
      httpMetadata: { contentType },
    });
    const replaced = await replaceCustomEmojiImage(c.env.DB, id, `emoji/${id}`, contentType);
    if (replaced.isErr()) {
      return jsonRepositoryError(c, replaced.error.message);
    }
  }

  const latest = await findCustomEmojiRowById(c.env.DB, id);
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(adminCustomEmojiJson(latest.value, identity.value.mediaPublicBaseUrl));
});

adminRoutes.delete("/api/v1/admin/custom_emojis/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const id = c.req.param("id") ?? "";
  const objectKey = await deleteCustomEmoji(c.env.DB, id);
  if (objectKey.isErr()) {
    return jsonRepositoryError(c, objectKey.error.message);
  }
  if (!objectKey.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  await c.env.MEDIA.delete(objectKey.value);
  return c.json({});
});

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

adminRoutes.get("/api/v1/admin/announcements", async (c) => {
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

adminRoutes.post("/api/v1/admin/announcements", async (c) => {
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

adminRoutes.put("/api/v1/admin/announcements/:id", async (c) => {
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

adminRoutes.delete("/api/v1/admin/announcements/:id", async (c) => {
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

adminRoutes.post("/api/v1/admin/announcements/:id/publish", (c) =>
  setAnnouncementPublication(c, true),
);
adminRoutes.post("/api/v1/admin/announcements/:id/unpublish", (c) =>
  setAnnouncementPublication(c, false),
);

const adminAccountDocument = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  moderation: AccountModeration | null,
): Promise<Record<string, unknown>> => ({
  ...(await mastodonAccountDocument(env, identity, account)),
  email: account.accessEmail.unwrap(),
  ip: null,
  role: { id: "-1", name: "user", highlighted: false },
  approved: true,
  disabled: moderation === "Suspended",
  silenced: moderation === "Silenced",
  suspended: moderation === "Suspended",
  limited: moderation !== null,
  sensitized: false,
  invited_by_account_id: null,
  created_by_application_id: null,
  invite_request: null,
});

adminRoutes.get("/api/v1/admin/accounts", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const limit = queryLimit(c.req.query("limit"), 40);
  const offset = Math.max(Number.parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  const accounts = await listAdminAccounts(c.env.DB, limit, offset);
  if (accounts.isErr()) {
    return jsonRepositoryError(c, accounts.error.message);
  }
  const moderations = await listAccountModerations(
    c.env.DB,
    accounts.value.map((account) => account.id),
  );
  if (moderations.isErr()) {
    return jsonRepositoryError(c, moderations.error.message);
  }
  const documents: Record<string, unknown>[] = [];
  for (const account of accounts.value) {
    documents.push(
      await adminAccountDocument(
        c.env,
        identity.value,
        account,
        moderations.value.get(account.id) ?? null,
      ),
    );
  }
  return c.json(documents);
});

const setAccountModerationRoute = async (
  c: Context<{ Bindings: Env }>,
  moderation: AccountModeration | null,
): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const account = await findAccountById(c.env.DB, c.req.param("id") ?? "");
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const changed = await setAccountModeration(c.env.DB, account.value.id, moderation);
  if (changed.isErr()) {
    return jsonRepositoryError(c, changed.error.message);
  }
  return c.json(await adminAccountDocument(c.env, identity.value, account.value, moderation));
};

adminRoutes.post("/api/v1/admin/accounts/:id/silence", (c) =>
  setAccountModerationRoute(c, "Silenced"),
);
adminRoutes.post("/api/v1/admin/accounts/:id/unsilence", (c) => setAccountModerationRoute(c, null));
adminRoutes.post("/api/v1/admin/accounts/:id/suspend", (c) =>
  setAccountModerationRoute(c, "Suspended"),
);
adminRoutes.post("/api/v1/admin/accounts/:id/unsuspend", (c) => setAccountModerationRoute(c, null));
adminRoutes.post("/api/v1/admin/accounts/:id/enable", (c) => setAccountModerationRoute(c, null));
