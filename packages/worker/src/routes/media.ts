import { Hono } from "hono";
import { InstanceLimits, characterCount } from "@tstodon/core";
import { jsonAuthError, jsonRepositoryError, requireUser } from "../http";
import { mastodonMedia } from "../media-document";
import {
  deleteMedia,
  findMediaById,
  insertMedia,
  parseMediaFocus,
  updateMediaMetadata,
} from "../media-store";
import { attachmentObjectKey, parseMediaObjectKey } from "../media-keys";
import { parseInstanceIdentity } from "../runtime-config";
import { newEntityId } from "../ids";
import type { Context } from "hono";

export const mediaRoutes = new Hono<{ Bindings: Env }>();

const CACHE_CONTROL = "public, max-age=31536000, immutable";

const uploadMedia = async (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) {
    return c.json({ error: "file is required", kind: "ValidationError" }, 400);
  }
  // Only the mime types this instance advertises are accepted.
  const contentType = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  const supported: ReadonlyArray<string> = InstanceLimits.media.supportedMimeTypes;
  if (!supported.includes(contentType)) {
    return c.json(
      {
        error: `unsupported media type: ${contentType || "unknown"}`,
        kind: "UnsupportedMediaType",
      },
      422,
    );
  }
  const id = newEntityId();
  const objectKey = attachmentObjectKey(user.value.id, id);
  await c.env.MEDIA.put(objectKey, await file.arrayBuffer(), {
    httpMetadata: { contentType },
  });
  const row = await insertMedia(c.env.DB, {
    id,
    accountId: user.value.id,
    objectKey,
    contentType,
  });
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  return c.json(mastodonMedia(identity.value, row.value), 200);
};

const serveR2Object = async (
  c: Context<{ Bindings: Env }>,
  objectKey: string,
  contentTypeFallback: string,
): Promise<Response> => {
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }
  const object = await c.env.MEDIA.get(objectKey);
  if (!object) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const contentType =
    object.httpMetadata?.contentType && object.httpMetadata.contentType.length > 0
      ? object.httpMetadata.contentType
      : contentTypeFallback;
  const response = new Response(object.body, {
    headers: {
      "content-type": contentType,
      "cache-control": CACHE_CONTROL,
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};

mediaRoutes.post("/api/v1/media", (c) => uploadMedia(c));
mediaRoutes.post("/api/v2/media", (c) => uploadMedia(c));

/** Attachment-id convenience lookup (local-core); production clients use MEDIA_PUBLIC_BASE_URL. */
mediaRoutes.get("/media/:id", async (c) => {
  const row = await findMediaById(c.env.DB, c.req.param("id"));
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return serveR2Object(c, row.value.object_key, row.value.content_type);
});

/**
 * Object-key proxy for local-core when MEDIA_PUBLIC_BASE_URL is the Worker origin.
 * Production serves the same keys from the R2 custom domain.
 */
const serveObjectKeyPath = async (c: Context<{ Bindings: Env }>) => {
  const key = parseMediaObjectKey(c.req.path.replace(/^\//, ""));
  if (!key) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return serveR2Object(c, key, "application/octet-stream");
};

mediaRoutes.get("/attachments/:accountId/:blobId", (c) => serveObjectKeyPath(c));
mediaRoutes.get("/avatars/:accountId/:blobId", (c) => serveObjectKeyPath(c));
mediaRoutes.get("/headers/:accountId/:blobId", (c) => serveObjectKeyPath(c));

/**
 * `GET /api/v1/media/:id`: the attachment document for its owner. Mastodon
 * scopes this to the uploading account, so someone else's id answers 404.
 */
mediaRoutes.get("/api/v1/media/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const row = await findMediaById(c.env.DB, c.req.param("id") ?? "");
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value || row.value.account_id !== user.value.id) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(mastodonMedia(identity.value, row.value));
});

const parseFocus = (raw: string): Readonly<{ x: number; y: number }> | undefined =>
  parseMediaFocus(raw);

mediaRoutes.put("/api/v1/media/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const id = c.req.param("id") ?? "";
  const row = await findMediaById(c.env.DB, id);
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value || row.value.account_id !== user.value.id) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (row.value.status_id) {
    return c.json({ error: "media is already attached to a status", kind: "MediaAttached" }, 422);
  }

  const body = await c.req.parseBody();
  const descriptionRaw = typeof body.description === "string" ? body.description : undefined;
  const focusRaw = typeof body.focus === "string" ? body.focus : undefined;
  let focusX = row.value.focus_x;
  let focusY = row.value.focus_y;
  if (focusRaw !== undefined) {
    const focus = parseFocus(focusRaw);
    if (!focus) {
      return c.json({ error: "invalid focus", kind: "ValidationError" }, 422);
    }
    focusX = focus.x;
    focusY = focus.y;
  }
  if (
    descriptionRaw !== undefined &&
    characterCount(descriptionRaw) > InstanceLimits.media.maxDescriptionCharacters
  ) {
    return c.json({ error: "description is too long", kind: "ValidationError" }, 422);
  }
  const description =
    descriptionRaw === undefined
      ? row.value.description
      : descriptionRaw.trim().length > 0
        ? descriptionRaw
        : null;

  const updated = await updateMediaMetadata(c.env.DB, {
    id,
    accountId: user.value.id,
    description,
    focusX,
    focusY,
  });
  if (updated.isErr()) {
    return jsonRepositoryError(c, updated.error.message);
  }
  if (!updated.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const latest = await findMediaById(c.env.DB, id);
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(mastodonMedia(identity.value, latest.value));
});

mediaRoutes.delete("/api/v1/media/:id", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const id = c.req.param("id") ?? "";
  const row = await findMediaById(c.env.DB, id);
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value || row.value.account_id !== user.value.id) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (row.value.status_id) {
    return c.json({ error: "media is already attached to a status", kind: "MediaAttached" }, 422);
  }
  const removed = await deleteMedia(c.env.DB, id, user.value.id);
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  if (removed.value) {
    await c.env.MEDIA.delete(removed.value);
  }
  return c.json({});
});
