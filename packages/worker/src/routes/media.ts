import { Hono } from "hono";
import type { Context } from "hono";
import { authenticate } from "../auth";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readBody,
  requireUser,
} from "../http";
import { mastodonMedia } from "../mastodon";
import { mediaIsPrivate, privateKeysForUpload } from "../media-access";
import { findMediaById, insertMedia, updateMediaMetadata, type MediaRow } from "../media-store";
import { parseMediaObjectKey } from "../media-keys";
import { normalizeMediaContentType, validateMediaUpload } from "../media-limits";
import { processUploadedImage } from "../media-process";
import { parseInstanceIdentity } from "../runtime-config";
import { newEntityId } from "../ids";
import { findStatusById } from "../status-store";
import { canViewStatus } from "../visibility-guard";
import { UpdateMediaBodySchema } from "../schemas";

export const mediaRoutes = new Hono<{ Bindings: Env }>();

const CACHE_CONTROL_PUBLIC = "public, max-age=31536000, immutable";
const CACHE_CONTROL_PRIVATE = "private, no-store";

const parseFocus = (raw: string | undefined): { x: number; y: number } | undefined => {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const parts = raw.split(",");
  if (parts.length !== 2) {
    return undefined;
  }
  const x = Number.parseFloat(parts[0]!.trim());
  const y = Number.parseFloat(parts[1]!.trim());
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return undefined;
  }
  return { x, y };
};

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
  const bytes = await file.arrayBuffer();
  const contentType = normalizeMediaContentType(file.type || "application/octet-stream");
  const validation = validateMediaUpload(contentType, bytes.byteLength);
  if (validation) {
    return c.json({ error: validation.message, kind: validation.kind }, 422);
  }
  const description = typeof body.description === "string" ? body.description : "";
  const focus = parseFocus(typeof body.focus === "string" ? body.focus : undefined);
  const id = newEntityId();
  const keys = privateKeysForUpload(user.value.id, id);
  const processed = await processUploadedImage(c.env.IMAGES, bytes);
  await c.env.MEDIA.put(keys.objectKey, bytes, {
    httpMetadata: { contentType },
  });
  let previewObjectKey: string | null = null;
  if (processed.previewBytes) {
    previewObjectKey = keys.previewObjectKey;
    await c.env.MEDIA.put(previewObjectKey, processed.previewBytes, {
      httpMetadata: { contentType: processed.previewContentType ?? "image/webp" },
    });
  }
  const row = await insertMedia(c.env.DB, {
    id,
    accountId: user.value.id,
    objectKey: keys.objectKey,
    contentType,
    description,
    focusX: focus?.x ?? null,
    focusY: focus?.y ?? null,
    previewObjectKey,
    metaJson: JSON.stringify(processed.meta),
    blurhash: processed.blurhash,
    isPrivate: true,
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
  cacheControl: string,
): Promise<Response> => {
  if (cacheControl.includes("public")) {
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
        "cache-control": cacheControl,
      },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
  const object = await c.env.MEDIA.get(objectKey);
  if (!object) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const contentType =
    object.httpMetadata?.contentType && object.httpMetadata.contentType.length > 0
      ? object.httpMetadata.contentType
      : contentTypeFallback;
  return new Response(object.body, {
    headers: {
      "content-type": contentType,
      "cache-control": cacheControl,
    },
  });
};

const viewerMayAccessPrivateMedia = async (
  c: Context<{ Bindings: Env }>,
  row: MediaRow,
): Promise<boolean> => {
  const auth = await authenticate(c.req.raw, c.env);
  const viewerId = auth.isOk() && auth.value.kind === "Account" ? auth.value.account.id : undefined;
  if (viewerId === row.account_id) {
    return true;
  }
  if (!row.status_id) {
    return false;
  }
  const status = await findStatusById(c.env.DB, row.status_id);
  if (status.isErr() || !status.value) {
    return false;
  }
  return canViewStatus(c.env.DB, status.value, viewerId);
};

mediaRoutes.post("/api/v1/media", (c) => uploadMedia(c));
mediaRoutes.post("/api/v2/media", (c) => uploadMedia(c));

mediaRoutes.get("/api/v1/media/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const row = await findMediaById(c.env.DB, c.req.param("id"));
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value || row.value.account_id !== user.value.id) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(mastodonMedia(identity.value, row.value), 200);
});

mediaRoutes.put("/api/v1/media/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readBody(c, UpdateMediaBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const existing = await findMediaById(c.env.DB, c.req.param("id"));
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  if (!existing.value || existing.value.account_id !== user.value.id) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (existing.value.status_id != null) {
    return c.json({ error: "media already attached", kind: "ValidationError" }, 422);
  }
  const focus = parseFocus(body.value.focus);
  const description =
    body.value.description !== undefined ? body.value.description : existing.value.description;
  const updated = await updateMediaMetadata(c.env.DB, {
    accountId: user.value.id,
    mediaId: existing.value.id,
    description,
    focusX: focus ? focus.x : body.value.focus === undefined ? existing.value.focus_x : null,
    focusY: focus ? focus.y : body.value.focus === undefined ? existing.value.focus_y : null,
  });
  if (updated.isErr()) {
    return jsonRepositoryError(c, updated.error.message);
  }
  if (!updated.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(mastodonMedia(identity.value, updated.value), 200);
});

/**
 * Auth-gated attachment bytes. Public attachments prefer MEDIA_PUBLIC_BASE_URL keys;
 * private / unattached uploads and restricted-visibility attachments require a viewer
 * who can see the owning status (or the uploader).
 */
mediaRoutes.get("/media/:id", async (c) => {
  const row = await findMediaById(c.env.DB, c.req.param("id"));
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const privateMedia = mediaIsPrivate(row.value);
  if (privateMedia) {
    if (!(await viewerMayAccessPrivateMedia(c, row.value))) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
  }
  const wantPreview = c.req.query("preview") === "1";
  const objectKey =
    wantPreview && row.value.preview_object_key
      ? row.value.preview_object_key
      : row.value.object_key;
  return serveR2Object(
    c,
    objectKey,
    row.value.content_type,
    privateMedia ? CACHE_CONTROL_PRIVATE : CACHE_CONTROL_PUBLIC,
  );
});

/**
 * Object-key proxy for local-core when MEDIA_PUBLIC_BASE_URL is the Worker origin.
 * Production serves the same keys from the R2 custom domain. Never serves private/* keys.
 */
const serveObjectKeyPath = async (c: Context<{ Bindings: Env }>) => {
  const key = parseMediaObjectKey(c.req.path.replace(/^\//, ""));
  if (!key) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return serveR2Object(c, key, "application/octet-stream", CACHE_CONTROL_PUBLIC);
};

mediaRoutes.get("/attachments/:accountId/:blobId", (c) => serveObjectKeyPath(c));
mediaRoutes.get("/attachments/:accountId/:blobId/preview", (c) => serveObjectKeyPath(c));
mediaRoutes.get("/avatars/:accountId/:blobId", (c) => serveObjectKeyPath(c));
mediaRoutes.get("/headers/:accountId/:blobId", (c) => serveObjectKeyPath(c));
