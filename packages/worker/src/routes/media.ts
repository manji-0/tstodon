import { Hono } from "hono";
import { jsonAuthError, jsonRepositoryError, requireUser } from "../http";
import { mastodonMedia } from "../mastodon";
import {
  deleteMedia,
  findMediaById,
  insertMedia,
  parseMediaFocus,
  updateMediaMetadata,
} from "../media-store";
import { parseInstanceIdentity } from "../runtime-config";
import { newEntityId } from "../ids";
import type { Context } from "hono";

export const mediaRoutes = new Hono<{ Bindings: Env }>();

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
  const id = newEntityId();
  const objectKey = `media/${user.value.id}/${id}`;
  await c.env.MEDIA.put(objectKey, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });
  const row = await insertMedia(c.env.DB, {
    accountId: user.value.id,
    objectKey,
    contentType: file.type || "application/octet-stream",
  });
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  return c.json(mastodonMedia(identity.value, row.value), 200);
};

mediaRoutes.post("/api/v1/media", (c) => uploadMedia(c));
mediaRoutes.post("/api/v2/media", (c) => uploadMedia(c));

mediaRoutes.get("/media/:id", async (c) => {
  const row = await findMediaById(c.env.DB, c.req.param("id"));
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (!row.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const object = await c.env.MEDIA.get(row.value.object_key);
  if (!object) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return new Response(object.body, {
    headers: {
      "content-type": row.value.content_type,
      "cache-control": "public, max-age=31536000",
    },
  });
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
