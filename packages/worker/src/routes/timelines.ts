import { Hono } from "hono";
import { authenticate } from "../auth";
import { jsonAuthError, jsonRepositoryError, queryLimit, requireUser } from "../http";
import { mastodonRemoteStatus, mastodonStatuses, remoteStatusVisible } from "../mastodon";
import { elapsedMs, writeMetric } from "../metrics";
import { parseInstanceIdentity } from "../runtime-config";
import { findRemoteActorByUri } from "../remote-actor-store";
import { listPublicRemoteStatuses } from "../remote-status-store";
import {
  listDirectStatusesForAccount,
  listHomeStatuses,
  listPublicStatuses,
  listTagStatuses,
} from "../status-store";

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
  const remote = await listPublicRemoteStatuses(c.env.DB, queryLimit(c.req.query("limit")));
  if (remote.isErr()) {
    return jsonRepositoryError(c, remote.error.message);
  }
  const localDocuments = await mastodonStatuses(c.env, identity.value, statuses.value, viewerId);
  const remoteDocuments: Record<string, unknown>[] = [];
  for (const status of remote.value) {
    const actor = await findRemoteActorByUri(c.env.DB, status.actorUri);
    if (actor.isErr() || !actor.value || !remoteStatusVisible(status)) {
      continue;
    }
    remoteDocuments.push(mastodonRemoteStatus(identity.value, status, actor.value));
  }
  const merged = [...localDocuments, ...remoteDocuments].sort((left, right) => {
    const leftAt = typeof left.created_at === "string" ? left.created_at : "";
    const rightAt = typeof right.created_at === "string" ? right.created_at : "";
    return rightAt.localeCompare(leftAt);
  });
  return c.json(merged.slice(0, queryLimit(c.req.query("limit"))));
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
  const startedAt = Date.now();
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
  const documents = await mastodonStatuses(c.env, identity.value, statuses.value, viewerId);
  writeMetric(c.env, "timeline.tag", [elapsedMs(startedAt), documents.length], ["ok"]);
  return c.json(documents);
});

timelineRoutes.get("/api/v1/timelines/direct", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const statuses = await listDirectStatusesForAccount(
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
