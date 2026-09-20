import { Hono } from "hono";
import { jsonAuthError, jsonRepositoryError, requireUser } from "../http";
import { mastodonMedia } from "../mastodon";
import { findMediaById, insertMedia } from "../media-store";
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
