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
  getAccountModeration,
  listAccountModerations,
  setAccountModeration,
  type AccountModeration,
} from "../account-moderation-store";
import {
  DomainBlockSeveritySchema,
  clearRemoteMediaForDomain,
  deleteDomainBlock,
  domainBlockDocument,
  findDomainBlockByDomain,
  findDomainBlockById,
  insertDomainBlock,
  listDomainBlocks,
  updateDomainBlock,
} from "../admin-domain-block-store";
import {
  approveAccount,
  disabledAccountIds,
  isAccountSensitized,
  mediaObjectKeysForAccount,
  pendingAccountIds,
  sensitizedAccountIds,
  setAccountDisabled,
  setAccountSensitized,
} from "../account-flag-store";
import { deleteAccount, findAccountById, listAdminAccounts } from "../account-store";
import { normalizeDomain } from "../domain-block-store";
import {
  canonicalEmailHash,
  deleteCanonicalEmailBlock,
  deleteEmailDomainBlock,
  emailDomainHistory,
  findCanonicalEmailBlockByEmail,
  findCanonicalEmailBlockById,
  findEmailDomainBlockById,
  insertCanonicalEmailBlock,
  insertEmailDomainBlock,
  listCanonicalEmailBlocks,
  listEmailDomainBlocks,
  type EmailDomainBlock,
} from "../registration-block-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryAdminLimit,
  queryCursor,
  queryLimit,
  queryOffset,
  queryTrendsLimit,
  readBody,
  readOptionalBody,
  requireAdmin,
} from "../http";
import { newEntityId } from "../ids";
import {
  mastodonAccountDocument,
  mastodonStatus,
  mastodonStatuses,
  mastodonTag,
} from "../mastodon";
import { instanceRules, parseInstanceIdentity } from "../runtime-config";
import { ReportCategorySchema, type ReportRow } from "../moderation-store";
import {
  findReportById,
  listOpenReportIdsForTarget,
  listReports,
  setReportAssigned,
  setReportResolved,
  updateReport,
} from "../moderation-store";
import {
  findStatusById,
  findStatusesByIds,
  listTrendingStatuses,
  listTrendingTags,
} from "../status-store";
import { tagDailyHistory } from "../tag-store";
import { cardDocument, listCachedLinkCards } from "../link-card";
import { fallbackLinkCard, listTrendingLinks } from "../trend-store";
import { listTrendReviews, setTrendReview, type TrendState } from "../trend-review-store";
import { StatusId } from "@tstodon/domain";
import { isTruthy } from "../schemas";
import { schemaResult } from "@tstodon/core";

export const adminRoutes = new Hono<{ Bindings: Env }>();

const CanonicalEmailBlockBodySchema = z.object({
  email: z.string().optional(),
  canonical_email_hash: z.string().optional(),
});

const CanonicalEmailTestBodySchema = z.object({ email: z.string().optional() });

const EmailDomainBlockBodySchema = z.object({ domain: z.string().optional() });

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

/**
 * Mastodon translates the admin account query parameters into a single
 * origin/status pair: local and active by default, `remote=true` switching the
 * origin, and one of the boolean status flags (last one wins in Mastodon's
 * order) switching the status.
 */
const adminAccountFilters = (
  c: Context<{ Bindings: Env }>,
): Readonly<{
  origin: "local" | "remote";
  status: "active" | "pending" | "disabled" | "silenced" | "suspended" | "sensitized";
  username?: string | undefined;
  displayName?: string | undefined;
  email?: string | undefined;
  byDomain?: string | undefined;
  ip?: string | undefined;
  staff?: boolean | undefined;
}> => {
  const present = (key: string): boolean => isTruthy(c.req.query(key));
  let status: "active" | "pending" | "disabled" | "silenced" | "suspended" = "active";
  for (const candidate of ["active", "pending", "disabled", "silenced", "suspended"] as const) {
    if (present(candidate)) {
      status = candidate;
    }
  }
  const trimmed = (key: string): string | undefined => {
    const value = c.req.query(key)?.trim() ?? "";
    return value.length > 0 ? value : undefined;
  };
  return {
    origin: present("remote") ? "remote" : "local",
    status: present("sensitized") ? "sensitized" : status,
    username: trimmed("username"),
    displayName: trimmed("display_name"),
    email: trimmed("email"),
    byDomain: trimmed("by_domain"),
    ip: trimmed("ip"),
    staff: present("staff"),
  };
};

const adminAccountDocument = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  moderation: AccountModeration | null,
  sensitized: boolean,
  pending: boolean,
  disabled: boolean,
): Promise<Record<string, unknown>> => ({
  ...(await mastodonAccountDocument(env, identity, account)),
  email: account.accessEmail.unwrap(),
  ip: null,
  role: { id: "-1", name: "user", highlighted: false },
  approved: !pending,
  // `disable` blocks the login; it is separate from suspension.
  disabled,
  silenced: moderation === "Silenced",
  suspended: moderation === "Suspended",
  limited: moderation !== null,
  sensitized,
  invited_by_account_id: null,
  created_by_application_id: null,
  invite_request: null,
});

adminRoutes.get("/api/v1/admin/accounts/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const document = await adminAccountFor(c.env, identity.value, c.req.param("id") ?? "");
  if (!document) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(document);
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
  const limit = queryAdminLimit(c.req.query("limit"));
  const offset = Math.max(Number.parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  const accounts = await listAdminAccounts(c.env.DB, {
    ...adminAccountFilters(c),
    cursor: queryCursor(c),
    limit,
    offset,
  });
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
  const sensitized = await sensitizedAccountIds(
    c.env.DB,
    accounts.value.map((account) => account.id),
  );
  if (sensitized.isErr()) {
    return jsonRepositoryError(c, sensitized.error.message);
  }
  const pending = await pendingAccountIds(
    c.env.DB,
    accounts.value.map((account) => account.id),
  );
  if (pending.isErr()) {
    return jsonRepositoryError(c, pending.error.message);
  }
  const disabled = await disabledAccountIds(
    c.env.DB,
    accounts.value.map((account) => account.id),
  );
  if (disabled.isErr()) {
    return jsonRepositoryError(c, disabled.error.message);
  }
  const documents: Record<string, unknown>[] = [];
  for (const account of accounts.value) {
    documents.push(
      await adminAccountDocument(
        c.env,
        identity.value,
        account,
        moderations.value.get(account.id) ?? null,
        sensitized.value.has(account.id),
        pending.value.has(account.id),
        disabled.value.has(account.id),
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
  const sensitized = await isAccountSensitized(c.env.DB, account.value.id);
  const pending = await pendingAccountIds(c.env.DB, [account.value.id]);
  const disabled = await disabledAccountIds(c.env.DB, [account.value.id]);
  return c.json(
    await adminAccountDocument(
      c.env,
      identity.value,
      account.value,
      moderation,
      sensitized.isOk() ? sensitized.value : false,
      pending.isOk() ? pending.value.has(account.value.id) : false,
      disabled.isOk() ? disabled.value.has(account.value.id) : false,
    ),
  );
};

adminRoutes.post("/api/v1/admin/accounts/:id/silence", (c) =>
  setAccountModerationRoute(c, "Silenced"),
);
adminRoutes.post("/api/v1/admin/accounts/:id/unsilence", (c) => setAccountModerationRoute(c, null));
adminRoutes.post("/api/v1/admin/accounts/:id/suspend", (c) =>
  setAccountModerationRoute(c, "Suspended"),
);
adminRoutes.post("/api/v1/admin/accounts/:id/unsuspend", (c) => setAccountModerationRoute(c, null));
/**
 * `POST /:id/enable` restores a disabled login (Mastodon's `user.enable!`); it
 * does not lift a silence or a suspension — `/unsilence` and `/unsuspend` do.
 */
adminRoutes.post("/api/v1/admin/accounts/:id/enable", async (c) => {
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
  const enabled = await setAccountDisabled(c.env.DB, account.value.id, false);
  if (enabled.isErr()) {
    return jsonRepositoryError(c, enabled.error.message);
  }
  const moderation = await getAccountModeration(c.env.DB, account.value.id);
  const sensitized = await isAccountSensitized(c.env.DB, account.value.id);
  const pending = await pendingAccountIds(c.env.DB, [account.value.id]);
  return c.json(
    await adminAccountDocument(
      c.env,
      identity.value,
      account.value,
      moderation.isOk() ? moderation.value : null,
      sensitized.isOk() ? sensitized.value : false,
      pending.isOk() ? pending.value.has(account.value.id) : false,
      false,
    ),
  );
});

/** An `Admin::Account` for an id, with its moderation and flag state. */
const adminAccountFor = async (
  env: Env,
  identity: InstanceIdentity,
  accountId: string,
): Promise<Record<string, unknown> | null> => {
  const account = await findAccountById(env.DB, accountId);
  if (account.isErr() || !account.value) {
    return null;
  }
  const moderation = await getAccountModeration(env.DB, accountId);
  const sensitized = await isAccountSensitized(env.DB, accountId);
  const pending = await pendingAccountIds(env.DB, [accountId]);
  const disabled = await disabledAccountIds(env.DB, [accountId]);
  return adminAccountDocument(
    env,
    identity,
    account.value,
    moderation.isOk() ? moderation.value : null,
    sensitized.isOk() ? sensitized.value : false,
    pending.isOk() && pending.value.has(accountId),
    disabled.isOk() && disabled.value.has(accountId),
  );
};

/** Mastodon's `Admin::Report` document. */
const adminReportDocument = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  report: ReportRow,
): Promise<Record<string, unknown>> => {
  const reported = await findStatusesByIds(c.env.DB, [...report.statusIds]);
  const statuses =
    reported.isOk() && reported.value.size > 0
      ? await mastodonStatuses(c.env, identity, [...reported.value.values()], undefined)
      : [];
  return {
    id: report.id,
    action_taken: report.actionTakenAt !== null,
    action_taken_at: report.actionTakenAt,
    category: report.category,
    comment: report.comment,
    forwarded: false,
    created_at: report.createdAt,
    updated_at: report.updatedAt ?? report.createdAt,
    account: await adminAccountFor(c.env, identity, report.accountId),
    target_account: await adminAccountFor(c.env, identity, report.targetAccountId),
    assigned_account: report.assignedAccountId
      ? await adminAccountFor(c.env, identity, report.assignedAccountId)
      : null,
    action_taken_by_account: report.actionTakenByAccountId
      ? await adminAccountFor(c.env, identity, report.actionTakenByAccountId)
      : null,
    statuses,
    // The configured rules this violation is tied to.
    rules: instanceRules(c.env)
      .filter((rule) => report.ruleIds.includes(rule.id))
      .map((rule) =>
        rule.hint === undefined
          ? { id: rule.id, text: rule.text }
          : { id: rule.id, text: rule.text, hint: rule.hint },
      ),
  };
};

/** Boolean report filters: `resolved=false` narrows to open reports. */
const reportResolvedFilter = (c: Context<{ Bindings: Env }>): boolean | undefined => {
  const raw = (c.req.query("resolved") ?? "").trim().toLowerCase();
  if (raw === "true" || raw === "1") {
    return true;
  }
  if (raw === "false" || raw === "0") {
    return false;
  }
  return undefined;
};

adminRoutes.get("/api/v1/admin/reports", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const reports = await listReports(c.env.DB, {
    resolved: reportResolvedFilter(c),
    accountId: c.req.query("account_id") || undefined,
    targetAccountId: c.req.query("target_account_id") || undefined,
    cursor: queryCursor(c),
    limit: queryAdminLimit(c.req.query("limit")),
  });
  if (reports.isErr()) {
    return jsonRepositoryError(c, reports.error.message);
  }
  const documents: Record<string, unknown>[] = [];
  for (const report of reports.value) {
    documents.push(await adminReportDocument(c, identity.value, report));
  }
  return c.json(documents);
});

adminRoutes.get("/api/v1/admin/reports/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const report = await findReportById(c.env.DB, c.req.param("id") ?? "");
  if (report.isErr()) {
    return jsonRepositoryError(c, report.error.message);
  }
  if (!report.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await adminReportDocument(c, identity.value, report.value));
});

const ReportUpdateBodySchema = z.object({
  category: z.string().optional(),
  rule_ids: z
    .union([z.array(z.union([z.string(), z.number()])), z.string(), z.number()])
    .optional(),
});

/** `rule_ids` accepts both the array and the `rule_ids[]` form. */
const reportRuleIds = (body: z.infer<typeof ReportUpdateBodySchema>, raw: unknown): string[] => {
  const collected: string[] = [];
  for (const source of [body.rule_ids, raw]) {
    if (Array.isArray(source)) {
      collected.push(...source.map((value) => String(value).trim()));
    } else if (typeof source === "string" || typeof source === "number") {
      collected.push(String(source).trim());
    }
  }
  return [...new Set(collected)].filter((value) => value.length > 0);
};

/**
 * `PUT /api/v1/admin/reports/:id` changes the category and, for a `violation`,
 * the configured rules it broke. Rules are the `INSTANCE_RULES` entries with
 * their 1-based ids, so an id this instance does not have is refused.
 */
adminRoutes.put("/api/v1/admin/reports/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readBody(c, ReportUpdateBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const rawRuleIds = c.req.queries("rule_ids[]") ?? c.req.queries("rule_ids") ?? [];
  const reported = await findReportById(c.env.DB, c.req.param("id") ?? "");
  if (reported.isErr()) {
    return jsonRepositoryError(c, reported.error.message);
  }
  if (!reported.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const category =
    body.value.category === undefined ? reported.value.category : body.value.category.trim();
  if (schemaResult(ReportCategorySchema)(category).isErr()) {
    return c.json(
      { error: "Validation failed: Category is not included in the list", kind: "ValidationError" },
      422,
    );
  }
  const providedRules = [...reportRuleIds(body.value, undefined), ...rawRuleIds];
  const uniqueRules = [...new Set(providedRules)];
  if (uniqueRules.length > 0 && category !== "violation") {
    return c.json(
      { error: "Validation failed: Rule ids must be blank", kind: "ValidationError" },
      422,
    );
  }
  // Mastodon validates `rule_ids` on any category change: leaving `violation`
  // without clearing them is refused, so rules never linger on a report that is
  // no longer a violation.
  const changedCategory = category !== reported.value.category;
  const rulesProvided = body.value.rule_ids !== undefined || rawRuleIds.length > 0;
  if (
    changedCategory &&
    category !== "violation" &&
    !rulesProvided &&
    reported.value.ruleIds.length > 0
  ) {
    return c.json(
      { error: "Validation failed: Rule ids must be blank", kind: "ValidationError" },
      422,
    );
  }
  const known = new Set(instanceRules(c.env).map((rule) => rule.id));
  if (uniqueRules.some((id) => !known.has(id))) {
    return c.json(
      { error: "Validation failed: Rule ids are invalid", kind: "ValidationError" },
      422,
    );
  }
  const changed = await updateReport(c.env.DB, reported.value.id, {
    category,
    ruleIds: body.value.rule_ids === undefined && rawRuleIds.length === 0 ? undefined : uniqueRules,
  });
  if (changed.isErr()) {
    return jsonRepositoryError(c, changed.error.message);
  }
  const updated = await findReportById(c.env.DB, reported.value.id);
  if (updated.isErr() || !updated.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await adminReportDocument(c, identity.value, updated.value));
});

/** Assign (`assign_to_self`) or unassign (`unassign`) a report. */
const assignReport = async (c: Context<{ Bindings: Env }>, assigned: boolean) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const id = c.req.param("id") ?? "";
  const changed = await setReportAssigned(c.env.DB, id, assigned ? admin.value.account.id : null);
  if (changed.isErr()) {
    return jsonRepositoryError(c, changed.error.message);
  }
  const report = await findReportById(c.env.DB, id);
  if (report.isErr()) {
    return jsonRepositoryError(c, report.error.message);
  }
  if (!report.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await adminReportDocument(c, identity.value, report.value));
};

adminRoutes.post("/api/v1/admin/reports/:id/assign_to_self", (c) => assignReport(c, true));
adminRoutes.post("/api/v1/admin/reports/:id/unassign", (c) => assignReport(c, false));

/** Resolve (`resolve`) or reopen (`reopen`) a report. */
const resolveReport = async (c: Context<{ Bindings: Env }>, resolved: boolean) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const id = c.req.param("id") ?? "";
  const changed = await setReportResolved(c.env.DB, id, resolved ? admin.value.account.id : null);
  if (changed.isErr()) {
    return jsonRepositoryError(c, changed.error.message);
  }
  const report = await findReportById(c.env.DB, id);
  if (report.isErr()) {
    return jsonRepositoryError(c, report.error.message);
  }
  if (!report.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await adminReportDocument(c, identity.value, report.value));
};

adminRoutes.post("/api/v1/admin/reports/:id/resolve", (c) => resolveReport(c, true));
adminRoutes.post("/api/v1/admin/reports/:id/reopen", (c) => resolveReport(c, false));

/** Canonical email blocks: a hash of the mailbox, so respellings stay blocked. */
adminRoutes.get("/api/v1/admin/canonical_email_blocks", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const blocks = await listCanonicalEmailBlocks(
    c.env.DB,
    queryAdminLimit(c.req.query("limit")),
    queryCursor(c),
  );
  if (blocks.isErr()) {
    return jsonRepositoryError(c, blocks.error.message);
  }
  return c.json(
    blocks.value.map((block) => ({ id: block.id, canonical_email_hash: block.canonicalEmailHash })),
  );
});

adminRoutes.get("/api/v1/admin/canonical_email_blocks/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const block = await findCanonicalEmailBlockById(c.env.DB, c.req.param("id") ?? "");
  if (block.isErr()) {
    return jsonRepositoryError(c, block.error.message);
  }
  if (!block.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({ id: block.value.id, canonical_email_hash: block.value.canonicalEmailHash });
});

/** `POST /test` answers the block an email would hit, without creating one. */
adminRoutes.post("/api/v1/admin/canonical_email_blocks/test", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readOptionalBody(c, CanonicalEmailTestBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const email = (body.value.email ?? "").trim();
  if (email.length === 0) {
    return jsonValidationError(c);
  }
  const block = await findCanonicalEmailBlockByEmail(c.env.DB, email);
  if (block.isErr()) {
    return jsonRepositoryError(c, block.error.message);
  }
  if (!block.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({ id: block.value.id, canonical_email_hash: block.value.canonicalEmailHash });
});

adminRoutes.post("/api/v1/admin/canonical_email_blocks", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readOptionalBody(c, CanonicalEmailBlockBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const email = (body.value.email ?? "").trim();
  const given = (body.value.canonical_email_hash ?? "").trim();
  let hash: string;
  if (email.length > 0) {
    hash = await canonicalEmailHash(email);
  } else if (given.length > 0) {
    hash = given;
  } else {
    return jsonValidationError(c);
  }
  const blocked = await insertCanonicalEmailBlock(c.env.DB, hash);
  if (blocked.isErr()) {
    // The unique index refuses a hash that is already blocked.
    return c.json(
      {
        error: "Validation failed: Canonical email hash has already been taken",
        kind: "ValidationError",
      },
      422,
    );
  }
  return c.json({ id: blocked.value.id, canonical_email_hash: blocked.value.canonicalEmailHash });
});

adminRoutes.delete("/api/v1/admin/canonical_email_blocks/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const removed = await deleteCanonicalEmailBlock(c.env.DB, c.req.param("id") ?? "");
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  if (!removed.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({});
});

const emailDomainBlockDocument = async (
  env: Env,
  block: EmailDomainBlock,
): Promise<Record<string, unknown>> => {
  const history = await emailDomainHistory(env.DB, block.domain);
  return {
    id: block.id,
    domain: block.domain,
    created_at: block.createdAt,
    history: history.isOk() ? history.value : [],
  };
};

adminRoutes.get("/api/v1/admin/email_domain_blocks", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const blocks = await listEmailDomainBlocks(
    c.env.DB,
    queryAdminLimit(c.req.query("limit")),
    queryCursor(c),
  );
  if (blocks.isErr()) {
    return jsonRepositoryError(c, blocks.error.message);
  }
  const documents: Record<string, unknown>[] = [];
  for (const block of blocks.value) {
    documents.push(await emailDomainBlockDocument(c.env, block));
  }
  return c.json(documents);
});

adminRoutes.get("/api/v1/admin/email_domain_blocks/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const block = await findEmailDomainBlockById(c.env.DB, c.req.param("id") ?? "");
  if (block.isErr()) {
    return jsonRepositoryError(c, block.error.message);
  }
  if (!block.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await emailDomainBlockDocument(c.env, block.value));
});

adminRoutes.post("/api/v1/admin/email_domain_blocks", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readOptionalBody(c, EmailDomainBlockBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const domain = normalizeDomain(body.value.domain ?? "");
  if (domain.length === 0) {
    return jsonValidationError(c);
  }
  const blocked = await insertEmailDomainBlock(c.env.DB, domain);
  if (blocked.isErr()) {
    return c.json(
      { error: "Validation failed: Domain has already been taken", kind: "ValidationError" },
      422,
    );
  }
  return c.json(await emailDomainBlockDocument(c.env, blocked.value));
});

adminRoutes.delete("/api/v1/admin/email_domain_blocks/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const removed = await deleteEmailDomainBlock(c.env.DB, c.req.param("id") ?? "");
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  if (!removed.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({});
});

const AdminDomainBlockBodySchema = z.object({
  domain: z.string().min(1).optional(),
  severity: DomainBlockSeveritySchema.optional(),
  reject_media: z.union([z.boolean(), z.string(), z.number()]).optional(),
  reject_reports: z.union([z.boolean(), z.string(), z.number()]).optional(),
  obfuscate: z.union([z.boolean(), z.string(), z.number()]).optional(),
  private_comment: z.string().nullable().optional(),
  public_comment: z.string().nullable().optional(),
});

const optionalComment = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

adminRoutes.get("/api/v1/admin/domain_blocks", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const blocks = await listDomainBlocks(
    c.env.DB,
    queryAdminLimit(c.req.query("limit")),
    c.req.query("max_id") ?? null,
    queryCursor(c),
  );
  if (blocks.isErr()) {
    return jsonRepositoryError(c, blocks.error.message);
  }
  return c.json(blocks.value.map(domainBlockDocument));
});

adminRoutes.get("/api/v1/admin/domain_blocks/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const block = await findDomainBlockById(c.env.DB, c.req.param("id") ?? "");
  if (block.isErr()) {
    return jsonRepositoryError(c, block.error.message);
  }
  if (!block.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(domainBlockDocument(block.value));
});

adminRoutes.post("/api/v1/admin/domain_blocks", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readBody(c, AdminDomainBlockBodySchema);
  if (body.isErr() || body.value.domain === undefined) {
    return validation(c, "domain is required");
  }
  const domain = normalizeDomain(body.value.domain);
  if (domain.length === 0) {
    return validation(c, "domain is required");
  }
  if (domain === identity.value.domain.toLowerCase()) {
    return validation(c, "You cannot block your own domain");
  }
  const existing = await findDomainBlockByDomain(c.env.DB, domain);
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  if (existing.value) {
    return validation(c, "domain has already been blocked");
  }
  const created = await insertDomainBlock(c.env.DB, {
    domain,
    severity: body.value.severity ?? "silence",
    rejectMedia: parseBool(body.value.reject_media, false),
    rejectReports: parseBool(body.value.reject_reports, false),
    obfuscate: parseBool(body.value.obfuscate, false),
    privateComment: optionalComment(body.value.private_comment) ?? null,
    publicComment: optionalComment(body.value.public_comment) ?? null,
  });
  if (created.isErr()) {
    return jsonRepositoryError(c, created.error.message);
  }
  const block = await findDomainBlockById(c.env.DB, created.value);
  if (block.isErr() || !block.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (block.value.reject_media !== 0) {
    await clearRemoteMediaForDomain(c.env.DB, block.value.domain);
  }
  return c.json(domainBlockDocument(block.value));
});

adminRoutes.put("/api/v1/admin/domain_blocks/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const id = c.req.param("id") ?? "";
  const existing = await findDomainBlockById(c.env.DB, id);
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  if (!existing.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const body = await readBody(c, AdminDomainBlockBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const privateComment = optionalComment(body.value.private_comment);
  const publicComment = optionalComment(body.value.public_comment);
  const updated = await updateDomainBlock(c.env.DB, id, {
    severity: body.value.severity ?? existing.value.severity,
    rejectMedia:
      body.value.reject_media === undefined
        ? existing.value.reject_media !== 0
        : parseBool(body.value.reject_media, false),
    rejectReports:
      body.value.reject_reports === undefined
        ? existing.value.reject_reports !== 0
        : parseBool(body.value.reject_reports, false),
    obfuscate:
      body.value.obfuscate === undefined
        ? existing.value.obfuscate !== 0
        : parseBool(body.value.obfuscate, false),
    privateComment: privateComment === undefined ? existing.value.private_comment : privateComment,
    publicComment: publicComment === undefined ? existing.value.public_comment : publicComment,
  });
  if (updated.isErr()) {
    return jsonRepositoryError(c, updated.error.message);
  }
  const block = await findDomainBlockById(c.env.DB, id);
  if (block.isErr() || !block.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (block.value.reject_media !== 0) {
    await clearRemoteMediaForDomain(c.env.DB, block.value.domain);
  }
  return c.json(domainBlockDocument(block.value));
});

adminRoutes.delete("/api/v1/admin/domain_blocks/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const removed = await deleteDomainBlock(c.env.DB, c.req.param("id") ?? "");
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  if (!removed.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({});
});

const setSensitized = async (
  c: Context<{ Bindings: Env }>,
  sensitized: boolean,
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
  const changed = await setAccountSensitized(c.env.DB, account.value.id, sensitized);
  if (changed.isErr()) {
    return jsonRepositoryError(c, changed.error.message);
  }
  const moderation = await getAccountModeration(c.env.DB, account.value.id);
  const pending = await pendingAccountIds(c.env.DB, [account.value.id]);
  const disabled = await disabledAccountIds(c.env.DB, [account.value.id]);
  return c.json(
    await adminAccountDocument(
      c.env,
      identity.value,
      account.value,
      moderation.isOk() ? moderation.value : null,
      sensitized,
      pending.isOk() ? pending.value.has(account.value.id) : false,
      disabled.isOk() ? disabled.value.has(account.value.id) : false,
    ),
  );
};

/**
 * Approve or reject the local account waiting for approval. Rejecting purges
 * the account (Mastodon's `DeleteAccountService`), so the document is built
 * first and answered with `approved: false`.
 */
const approveOrReject = async (c: Context<{ Bindings: Env }>, approve: boolean) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const id = c.req.param("id") ?? "";
  const account = await findAccountById(c.env.DB, id);
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const moderation = await getAccountModeration(c.env.DB, id);
  const sensitized = await isAccountSensitized(c.env.DB, id);
  const disabled = await disabledAccountIds(c.env.DB, [id]);
  const loginDisabled = disabled.isOk() && disabled.value.has(id);
  if (approve) {
    const approved = await approveAccount(c.env.DB, id);
    if (approved.isErr()) {
      return jsonRepositoryError(c, approved.error.message);
    }
    return c.json(
      await adminAccountDocument(
        c.env,
        identity.value,
        account.value,
        moderation.isOk() ? moderation.value : null,
        sensitized.isOk() ? sensitized.value : false,
        false,
        loginDisabled,
      ),
    );
  }
  const document = await adminAccountDocument(
    c.env,
    identity.value,
    account.value,
    moderation.isOk() ? moderation.value : null,
    sensitized.isOk() ? sensitized.value : false,
    true,
    loginDisabled,
  );
  const objects = await mediaObjectKeysForAccount(c.env.DB, id);
  if (objects.isErr()) {
    return jsonRepositoryError(c, objects.error.message);
  }
  for (const objectKey of objects.value) {
    await c.env.MEDIA.delete(objectKey);
  }
  const purged = await deleteAccount(c.env.DB, id);
  if (purged.isErr()) {
    return jsonRepositoryError(c, purged.error.message);
  }
  return c.json(document);
};

const AccountActionBodySchema = z.object({
  type: z.string().optional(),
  report_id: z.union([z.string(), z.number()]).optional(),
});

/**
 * `POST /api/v1/admin/accounts/:id/action` — the moderation action Mastodon
 * documents (`none`, `sensitive`, `disable`, `silence`, `suspend`). The report
 * resolution and warning text around it are not part of this instance yet.
 */
adminRoutes.post("/api/v1/admin/accounts/:id/action", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readBody(c, AccountActionBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const type = (body.value.type ?? "").trim().toLowerCase();
  if (!["none", "sensitive", "disable", "silence", "suspend"].includes(type)) {
    return c.json({ error: "Record invalid", kind: "ValidationError" }, 422);
  }
  const account = await findAccountById(c.env.DB, c.req.param("id") ?? "");
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const id = account.value.id;
  if (type === "sensitive") {
    const changed = await setAccountSensitized(c.env.DB, id, true);
    if (changed.isErr()) {
      return jsonRepositoryError(c, changed.error.message);
    }
  }
  if (type === "disable") {
    const changed = await setAccountDisabled(c.env.DB, id, true);
    if (changed.isErr()) {
      return jsonRepositoryError(c, changed.error.message);
    }
  }
  if (type === "silence" || type === "suspend") {
    const changed = await setAccountModeration(
      c.env.DB,
      id,
      type === "silence" ? "Silenced" : "Suspended",
    );
    if (changed.isErr()) {
      return jsonRepositoryError(c, changed.error.message);
    }
  }
  // Mastodon resolves the report that prompted the action, or every open
  // report against the account when none is named.
  const requestedReport = body.value.report_id;
  const reportId = requestedReport === undefined ? "" : String(requestedReport).trim();
  const reporterAccountId = admin.value.account.id;
  if (reportId.length > 0) {
    const report = await findReportById(c.env.DB, reportId);
    if (report.isErr()) {
      return jsonRepositoryError(c, report.error.message);
    }
    if (!report.value) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    const resolved = await setReportResolved(c.env.DB, reportId, reporterAccountId);
    if (resolved.isErr()) {
      return jsonRepositoryError(c, resolved.error.message);
    }
  } else {
    const open = await listOpenReportIdsForTarget(c.env.DB, id);
    if (open.isErr()) {
      return jsonRepositoryError(c, open.error.message);
    }
    for (const openId of open.value) {
      const resolved = await setReportResolved(c.env.DB, openId, reporterAccountId);
      if (resolved.isErr()) {
        return jsonRepositoryError(c, resolved.error.message);
      }
    }
  }
  return c.json({});
});

adminRoutes.post("/api/v1/admin/accounts/:id/approve", (c) => approveOrReject(c, true));
adminRoutes.post("/api/v1/admin/accounts/:id/reject", (c) => approveOrReject(c, false));

adminRoutes.post("/api/v1/admin/accounts/:id/sensitize", (c) => setSensitized(c, true));
adminRoutes.post("/api/v1/admin/accounts/:id/unsensitize", (c) => setSensitized(c, false));

adminRoutes.delete("/api/v1/admin/accounts/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const id = c.req.param("id") ?? "";
  const account = await findAccountById(c.env.DB, id);
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  // Drop the account's bucket objects first; rows cascade from `accounts`.
  const objects = await mediaObjectKeysForAccount(c.env.DB, id);
  if (objects.isErr()) {
    return jsonRepositoryError(c, objects.error.message);
  }
  for (const objectKey of objects.value) {
    await c.env.MEDIA.delete(objectKey);
  }
  const purged = await deleteAccount(c.env.DB, id);
  if (purged.isErr()) {
    return jsonRepositoryError(c, purged.error.message);
  }
  if (!purged.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({});
});

/** The review fields Mastodon's Admin::Tag serializer adds to a tag. */
const adminTagFields = (state: TrendState | undefined): Record<string, unknown> => ({
  trendable: state !== "Rejected",
  usable: true,
  requires_review: state === undefined,
});

const adminTagDocument = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  name: string,
  state: TrendState | undefined,
): Promise<Record<string, unknown>> => ({
  ...mastodonTag(identity, name, {
    history: (await tagDailyHistory(c.env.DB, name)).unwrapOr([]),
  }),
  ...adminTagFields(state),
});

const notFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

adminRoutes.get("/api/v1/admin/trends/tags", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const states = await listTrendReviews(c.env.DB, "Tag");
  if (states.isErr()) {
    return jsonRepositoryError(c, states.error.message);
  }
  const tags = await listTrendingTags(c.env.DB, queryTrendsLimit(c.req.query("limit")), {
    offset: queryOffset(c.req.query("offset")),
  });
  if (tags.isErr()) {
    return jsonRepositoryError(c, tags.error.message);
  }
  const documents = [];
  for (const tag of tags.value) {
    documents.push(await adminTagDocument(c, identity.value, tag.name, states.value.get(tag.name)));
  }
  return c.json(documents);
});

const reviewTag = (state: TrendState) => async (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const name = (c.req.param("id") ?? "").trim();
  if (name.length === 0) {
    return notFound(c);
  }
  const saved = await setTrendReview(c.env.DB, "Tag", name, state);
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  return c.json(await adminTagDocument(c, identity.value, name, state));
};

adminRoutes.post("/api/v1/admin/trends/tags/:id/approve", reviewTag("Approved"));
adminRoutes.post("/api/v1/admin/trends/tags/:id/reject", reviewTag("Rejected"));

adminRoutes.get("/api/v1/admin/trends/links", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const links = await listTrendingLinks(c.env.DB, {
    limit: queryTrendsLimit(c.req.query("limit")),
    offset: queryOffset(c.req.query("offset")),
  });
  if (links.isErr()) {
    return jsonRepositoryError(c, links.error.message);
  }
  return c.json(links.value.map((link) => link.document));
});

const reviewLink = (state: TrendState) => async (c: Context<{ Bindings: Env }>) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  // A link trend has no row id of its own, so the URL is its identifier.
  const url = c.req.param("id") ?? "";
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return notFound(c);
  }
  const saved = await setTrendReview(c.env.DB, "Link", url, state);
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  const cached = await listCachedLinkCards(c.env.DB, [url]);
  const preview = cached.get(url);
  return c.json(preview ? cardDocument(preview) : (fallbackLinkCard(url) ?? {}));
};

adminRoutes.post("/api/v1/admin/trends/links/:id/approve", reviewLink("Approved"));
adminRoutes.post("/api/v1/admin/trends/links/:id/reject", reviewLink("Rejected"));

adminRoutes.get("/api/v1/admin/trends/statuses", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  // The admin list keeps rejected statuses so a moderator can approve them.
  const statuses = await listTrendingStatuses(c.env.DB, queryLimit(c.req.query("limit")), {
    includeRejected: true,
    offset: queryOffset(c.req.query("offset")),
  });
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  return c.json(await mastodonStatuses(c.env, identity.value, statuses.value, undefined));
});

const reviewStatus = (state: TrendState) => async (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const raw = c.req.param("id") ?? "";
  const id = StatusId.parse(raw);
  if (id.isErr()) {
    return notFound(c);
  }
  const found = await findStatusById(c.env.DB, id.value);
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value) {
    return notFound(c);
  }
  const saved = await setTrendReview(c.env.DB, "Status", raw, state);
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  return c.json(
    (await mastodonStatus(c.env, identity.value, found.value, admin.value.account.id)) ?? {},
  );
};

adminRoutes.post("/api/v1/admin/trends/statuses/:id/approve", reviewStatus("Approved"));
adminRoutes.post("/api/v1/admin/trends/statuses/:id/reject", reviewStatus("Rejected"));
