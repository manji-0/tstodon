import { InstanceLimits, schemaResult } from "@tstodon/core";
import { UploadMetadata } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readOptionalBody,
  requireUser,
} from "../http";
import { mastodonMedia, mediaUrl } from "../media-document";
import {
  deleteMedia,
  findMediaById,
  insertMedia,
  parseMediaFocus,
  updateMediaMetadata,
} from "../media-store";
import {
  isLegacyAttachmentObjectKey,
  newAttachmentObjectKey,
  parseMediaObjectKey,
} from "../media-keys";
import { imagesBindingAnalyzer, isAnalyzedImageType, processUploadedImage } from "../media-image";
import { parseInstanceIdentity } from "../runtime-config";
import { newEntityId } from "../ids";
import { browserSession } from "../browser-session";
import { mediaDescriptionFits } from "../status-body-schema";
import { findStatusById } from "../status-store";
import { canViewStatus } from "../visibility-guard";
import type { Context } from "hono";
import { z } from "zod";

const CACHE_CONTROL = "public, max-age=31536000, immutable";

/** The alt text and focal point fields, read at upload and by `PUT /api/v1/media/:id`. */
const MediaMetadataBodySchema = z.object({
  description: z.string().nullish(),
  focus: z.string().nullish(),
});

/**
 * What a request sets: `undefined` keeps the stored value, and a blank
 * description becomes `null`, which clears it.
 */
type MediaMetadataEdit = Readonly<{
  description: string | null | undefined;
  focus: Readonly<{ x: number; y: number }> | undefined;
}>;

type MediaMetadataError = Readonly<{ kind: "InvalidFocus" } | { kind: "DescriptionTooLong" }>;

const parseMediaMetadata = (
  body: z.infer<typeof MediaMetadataBodySchema>,
): Result<MediaMetadataEdit, MediaMetadataError> => {
  // A blank focus field is no focus at all, as some clients send it empty.
  const focusText = body.focus == null || body.focus.trim() === "" ? undefined : body.focus;
  const focus = focusText === undefined ? undefined : parseMediaFocus(focusText);
  if (focusText !== undefined && focus === undefined) {
    return err({ kind: "InvalidFocus" });
  }
  if (body.description != null && !mediaDescriptionFits(body.description)) {
    return err({ kind: "DescriptionTooLong" });
  }
  const description =
    body.description == null
      ? undefined
      : body.description.trim().length > 0
        ? body.description
        : null;
  return ok({ description, focus });
};

const jsonMediaMetadataError = (c: Context<{ Bindings: Env }>, error: MediaMetadataError) =>
  c.json(
    {
      error: error.kind === "InvalidFocus" ? "invalid focus" : "description is too long",
      kind: "ValidationError",
    },
    422,
  );

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
  const fields = schemaResult(MediaMetadataBodySchema)(body);
  if (fields.isErr()) {
    return jsonValidationError(c);
  }
  const metadata = parseMediaMetadata(fields.value);
  if (metadata.isErr()) {
    return jsonMediaMetadataError(c, metadata.error);
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
  // Metadata (an image's EXIF with its GPS position, XMP, IPTC, comments; a
  // video's location, device and date atoms or tags) never reaches the
  // bucket: a file that cannot be rewritten without it is refused.
  const scrubbed = UploadMetadata.forUpload(contentType, new Uint8Array(await file.arrayBuffer()));
  if (scrubbed.isErr()) {
    const kind = contentType.startsWith("video/") ? "MediaVideoRejected" : "MediaImageRejected";
    console.warn(JSON.stringify({ kind, error: scrubbed.error }));
    return c.json(
      { error: `file is not a readable ${contentType} file`, kind: "ValidationError" },
      422,
    );
  }
  const bytes = scrubbed.value;
  const id = newEntityId();
  const objectKey = newAttachmentObjectKey(user.value.id);
  await c.env.MEDIA.put(objectKey, bytes, {
    httpMetadata: { contentType },
  });
  const image = isAnalyzedImageType(contentType)
    ? await processUploadedImage(
        c.env.MEDIA,
        imagesBindingAnalyzer(c.env.IMAGES),
        user.value.id,
        bytes,
      )
    : null;
  const row = await insertMedia(c.env.DB, {
    id,
    accountId: user.value.id,
    objectKey,
    contentType,
    description: metadata.value.description ?? null,
    focus: metadata.value.focus ?? null,
    image,
  });
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  return c.json(mastodonMedia(identity.value, row.value), 200);
};

/**
 * Serve an object from R2 through the edge cache. An attachment at a legacy,
 * id-derived key bypasses the cache, so it stops answering as soon as the
 * rekey job deletes it.
 */
const serveR2Object = async (
  c: Context<{ Bindings: Env }>,
  objectKey: string,
): Promise<Response> => {
  const cacheable = !isLegacyAttachmentObjectKey(objectKey);
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  const cached = cacheable ? await cache.match(cacheKey) : undefined;
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
      : "application/octet-stream";
  const response = new Response(object.body, {
    headers: {
      "content-type": contentType,
      "cache-control": cacheable ? CACHE_CONTROL : "no-store",
    },
  });
  if (cacheable) {
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
};

export const postV1Media = (c: Context<{ Bindings: Env }, "/api/v1/media">) => uploadMedia(c);
export const postV2Media = (c: Context<{ Bindings: Env }, "/api/v2/media">) => uploadMedia(c);

/**
 * `GET /media/:id`, as Mastodon's MediaController#show: a local attachment on
 * a status the signed-in viewer may see redirects to its file; anything else,
 * unattached media included, answers 404.
 */
export const getMediaById = async (c: Context<{ Bindings: Env }, "/media/:id">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const row = await findMediaById(c.env.DB, c.req.param("id"));
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value?.status_id) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const status = await findStatusById(c.env.DB, row.value.status_id);
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  const session = await browserSession(c.req.raw, c.env);
  const viewerId = session.kind === "Account" ? session.account.id : undefined;
  if (!status.value || !(await canViewStatus(c.env.DB, status.value, viewerId))) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.redirect(mediaUrl(identity.value, row.value.object_key), 302);
};

/**
 * Object-key proxy for local-core when MEDIA_PUBLIC_BASE_URL is the Worker origin.
 * Production serves the same keys from the R2 custom domain.
 */
const serveObjectKeyPath = async (c: Context<{ Bindings: Env }>) => {
  const key = parseMediaObjectKey(c.req.path.replace(/^\//, ""));
  if (!key) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return serveR2Object(c, key);
};

export const getAttachmentsByAccountIdByBlobId = (
  c: Context<{ Bindings: Env }, "/attachments/:accountId/:blobId">,
) => serveObjectKeyPath(c);
export const getAvatarsByAccountIdByBlobId = (
  c: Context<{ Bindings: Env }, "/avatars/:accountId/:blobId">,
) => serveObjectKeyPath(c);
export const getHeadersByAccountIdByBlobId = (
  c: Context<{ Bindings: Env }, "/headers/:accountId/:blobId">,
) => serveObjectKeyPath(c);

/**
 * `GET /api/v1/media/:id`: the attachment document for its owner. Mastodon
 * scopes this to the uploading account, so someone else's id answers 404.
 */
export const getV1MediaById = async (c: Context<{ Bindings: Env }, "/api/v1/media/:id">) => {
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
};

export const putV1MediaById = async (c: Context<{ Bindings: Env }, "/api/v1/media/:id">) => {
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

  // The web UI sends JSON; other clients send a form.
  const body = await readOptionalBody(c, MediaMetadataBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const metadata = parseMediaMetadata(body.value);
  if (metadata.isErr()) {
    return jsonMediaMetadataError(c, metadata.error);
  }
  const { description, focus } = metadata.value;
  const updated = await updateMediaMetadata(c.env.DB, {
    id,
    accountId: user.value.id,
    description: description === undefined ? row.value.description : description,
    focusX: focus === undefined ? row.value.focus_x : focus.x,
    focusY: focus === undefined ? row.value.focus_y : focus.y,
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
};

export const deleteV1MediaById = async (c: Context<{ Bindings: Env }, "/api/v1/media/:id">) => {
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
  if (removed.value.length > 0) {
    await c.env.MEDIA.delete([...removed.value]);
  }
  return c.json({});
};
