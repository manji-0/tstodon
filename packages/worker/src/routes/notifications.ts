import { Hono } from "hono";
import { jsonAuthError, jsonRepositoryError, queryLimit, requireUser } from "../http";
import { mastodonNotification } from "../mastodon";
import { parseInstanceIdentity } from "../runtime-config";
import { listNotifications } from "../social-store";

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
  const rows = await listNotifications(
    c.env.DB,
    user.value.id,
    queryLimit(c.req.query("limit")),
  );
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
