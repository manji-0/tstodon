import { Hono } from "hono";
import { jsonAuthError, jsonRepositoryError, queryLimit, requireUser } from "../http";
import { getMarkers } from "../marker-store";
import { mastodonNotification } from "../mastodon";
import { parseInstanceIdentity } from "../runtime-config";
import {
  clearNotifications,
  countUnreadNotifications,
  dismissNotification,
  listNotifications,
} from "../social-store";

export const notificationRoutes = new Hono<{ Bindings: Env }>();

notificationRoutes.get("/api/v1/notifications", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const rows = await listNotifications(c.env.DB, user.value.id, queryLimit(c.req.query("limit")));
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  const documents = [];
  for (const row of rows.value) {
    const document = await mastodonNotification(c.env, identity.value, row, user.value.id);
    if (document) {
      documents.push(document);
    }
  }
  return c.json(documents);
});

notificationRoutes.get("/api/v1/notifications/unread_count", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const markers = await getMarkers(c.env.DB, user.value.id, ["notifications"]);
  if (markers.isErr()) {
    return jsonRepositoryError(c, markers.error.message);
  }
  const markerId = markers.value.notifications?.last_read_id;
  const count = await countUnreadNotifications(c.env.DB, user.value.id, markerId);
  if (count.isErr()) {
    return jsonRepositoryError(c, count.error.message);
  }
  return c.json({ count: count.value });
});

notificationRoutes.post("/api/v1/notifications/clear", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const cleared = await clearNotifications(c.env.DB, user.value.id);
  if (cleared.isErr()) {
    return jsonRepositoryError(c, cleared.error.message);
  }
  return c.json({});
});

notificationRoutes.post("/api/v1/notifications/:id/dismiss", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const dismissed = await dismissNotification(c.env.DB, user.value.id, c.req.param("id") ?? "");
  if (dismissed.isErr()) {
    return jsonRepositoryError(c, dismissed.error.message);
  }
  if (!dismissed.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({});
});
