import type { Context } from "hono";
import {
  changeCustomEmoji,
  removeCustomEmoji,
  UPLOAD_EMOJI_ERRORS,
  uploadCustomEmoji,
  uploadedFile,
} from "../../admin-custom-emojis";
import {
  adminCustomEmojiJson,
  findCustomEmojiRowById,
  listCustomEmojiRows,
} from "../../custom-emoji-store";
import { jsonAuthError, jsonRepositoryError, requireAdmin } from "../../http";
import { parseInstanceIdentity } from "../../runtime-config";
import { parseBool, validation } from "./shared";

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

export const getV1AdminCustomEmojis = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/custom_emojis">,
) => {
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
};

export const postV1AdminCustomEmojis = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/custom_emojis">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await c.req.parseBody();
  const uploaded = await uploadCustomEmoji(c.env, identity.value.mediaPublicBaseUrl, {
    shortcode: typeof body.shortcode === "string" ? body.shortcode : "",
    image: uploadedFile(body.image),
    visibleInPicker: parseBool(body.visible_in_picker, true),
    category: optionalCategory(body.category) ?? null,
  });
  if (uploaded.isErr()) {
    return uploaded.error.kind === "RepositoryError"
      ? jsonRepositoryError(c, uploaded.error.message)
      : validation(c, UPLOAD_EMOJI_ERRORS[uploaded.error.kind]);
  }
  return c.json(adminCustomEmojiJson(uploaded.value, identity.value.mediaPublicBaseUrl));
};

export const patchV1AdminCustomEmojisById = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/custom_emojis/:id">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const id = c.req.param("id") ?? "";
  const existing = await findCustomEmojiRowById(c.env.DB, id);
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  if (!existing.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const current = existing.value.visible_in_picker !== 0;

  let visibleInPicker: boolean | undefined;
  let category: string | null | undefined;
  let image: File | undefined;
  if ((c.req.header("content-type") ?? "").includes("application/json")) {
    const body = await c.req.json<Record<string, unknown>>();
    if (body.visible_in_picker !== undefined) {
      visibleInPicker = parseBool(body.visible_in_picker, current);
    }
    category = optionalCategory(body.category);
  } else {
    const body = await c.req.parseBody();
    if (body.visible_in_picker !== undefined) {
      visibleInPicker = parseBool(body.visible_in_picker, current);
    }
    category = optionalCategory(body.category);
    image = uploadedFile(body.image);
  }

  const latest = await changeCustomEmoji(c.env, id, { visibleInPicker, category, image });
  if (latest.isErr()) {
    return jsonRepositoryError(c, latest.error.message);
  }
  if (!latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(adminCustomEmojiJson(latest.value, identity.value.mediaPublicBaseUrl));
};

export const deleteV1AdminCustomEmojisById = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/custom_emojis/:id">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const removed = await removeCustomEmoji(c.env, c.req.param("id") ?? "");
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  if (!removed.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({});
};
