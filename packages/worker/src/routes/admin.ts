import { Hono } from "hono";
import type { Context } from "hono";
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
import { jsonAuthError, jsonRepositoryError, requireAdmin } from "../http";
import { newEntityId } from "../ids";
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
