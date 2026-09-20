import { Hono } from "hono";
import { authenticate } from "../auth";
import { jsonAuthError, jsonRepositoryError, queryLimit, requireUser } from "../http";
import { mastodonStatuses } from "../mastodon";
import { parseInstanceIdentity } from "../runtime-config";
import { listHomeStatuses, listPublicStatuses, listTagStatuses } from "../status-store";

export const timelineRoutes = new Hono<{ Bindings: Env }>();

timelineRoutes.get("/api/v1/timelines/public", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const statuses = await listPublicStatuses(
    c.env.DB,
    queryLimit(c.req.query("limit")),
    c.req.query("max_id"),
  );
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  return c.json(await mastodonStatuses(c.env, identity.value, statuses.value, viewerId));
});

timelineRoutes.get("/api/v1/timelines/home", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const statuses = await listHomeStatuses(
    c.env.DB,
    user.value.id,
    queryLimit(c.req.query("limit")),
    c.req.query("max_id"),
  );
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  return c.json(await mastodonStatuses(c.env, identity.value, statuses.value, user.value.id));
});

timelineRoutes.get("/api/v1/timelines/tag/:hashtag", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const statuses = await listTagStatuses(
    c.env.DB,
    c.req.param("hashtag"),
    queryLimit(c.req.query("limit")),
  );
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  return c.json(await mastodonStatuses(c.env, identity.value, statuses.value, viewerId));
});

timelineRoutes.get("/api/v1/timelines/direct", (c) => c.json([]));
