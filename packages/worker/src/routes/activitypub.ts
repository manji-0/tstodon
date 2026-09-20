import {
  ActivityId,
  InboxActivity,
  InstanceIdentity,
  LocalStatus,
  StatusId,
} from "@tstodon/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  findAccountById,
  findAccountByUsername,
} from "../account-store";
import {
  activityPayloadFromJson,
  actorDocument,
  noteDocument,
  parseLocalActorUsername,
  parseLocalStatusId,
} from "../activitypub";
import { jsonRepositoryError, queryLimit } from "../http";
import { verifyInboxRequest } from "../http-signature";
import { inboxActivityExists, insertInboxActivity } from "../inbox-store";
import { listOutboundActivities } from "../outbox-store";
import { parseInstanceIdentity } from "../runtime-config";
import {
  favouriteStatus,
  followAccount,
  insertNotification,
  listFollowers,
  listFollowing,
  unfollowAccount,
} from "../social-store";
import { findStatusById, insertLocalReblog } from "../status-store";
import { nowInstant } from "../clock";
import { newEntityId } from "../ids";

export const activityPubRoutes = new Hono<{ Bindings: Env }>();

const jsonLd = {
  "content-type": "application/activity+json",
};

activityPubRoutes.get("/users/:username", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const account = await findAccountByUsername(c.env.DB, c.req.param("username"));
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ kind: "NotFound" }, 404);
  }
  return c.json(actorDocument(identity.value, account.value), 200, jsonLd);
});

activityPubRoutes.get("/users/:username/statuses/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const account = await findAccountByUsername(c.env.DB, c.req.param("username"));
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const status = await findStatusById(c.env.DB, c.req.param("id"));
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  if (!status.value || status.value.kind !== "LocalNote" || status.value.accountId !== account.value.id) {
    return c.json({ kind: "NotFound" }, 404);
  }
  return c.json(noteDocument(identity.value, account.value, status.value), 200, jsonLd);
});

const collection = (
  id: string,
  items: ReadonlyArray<string>,
) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id,
  type: "OrderedCollection",
  totalItems: items.length,
  orderedItems: items,
});

activityPubRoutes.get("/users/:username/outbox", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const account = await findAccountByUsername(c.env.DB, c.req.param("username"));
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const rows = await listOutboundActivities(
    c.env.DB,
    account.value.id,
    queryLimit(c.req.query("limit"), 20),
  );
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  const actor = InstanceIdentity.actorUrl(identity.value, account.value.username);
  const items = rows.value.map((row) => JSON.parse(row.payload_json) as unknown);
  return c.json(
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actor}/outbox`,
      type: "OrderedCollection",
      totalItems: items.length,
      orderedItems: items,
    },
    200,
    jsonLd,
  );
});

activityPubRoutes.get("/users/:username/followers", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const account = await findAccountByUsername(c.env.DB, c.req.param("username"));
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const ids = await listFollowers(c.env.DB, account.value.id, queryLimit(c.req.query("limit")));
  if (ids.isErr()) {
    return jsonRepositoryError(c, ids.error.message);
  }
  const items: string[] = [];
  for (const id of ids.value) {
    const follower = await findAccountById(c.env.DB, id);
    if (follower.isOk() && follower.value) {
      items.push(InstanceIdentity.actorUrl(identity.value, follower.value.username));
    }
  }
  const actor = InstanceIdentity.actorUrl(identity.value, account.value.username);
  return c.json(collection(`${actor}/followers`, items), 200, jsonLd);
});

activityPubRoutes.get("/users/:username/following", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const account = await findAccountByUsername(c.env.DB, c.req.param("username"));
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const ids = await listFollowing(c.env.DB, account.value.id, queryLimit(c.req.query("limit")));
  if (ids.isErr()) {
    return jsonRepositoryError(c, ids.error.message);
  }
  const items: string[] = [];
  for (const id of ids.value) {
    const target = await findAccountById(c.env.DB, id);
    if (target.isOk() && target.value) {
      items.push(InstanceIdentity.actorUrl(identity.value, target.value.username));
    }
  }
  const actor = InstanceIdentity.actorUrl(identity.value, account.value.username);
  return c.json(collection(`${actor}/following`, items), 200, jsonLd);
});

const handleInbox = async (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const raw = await c.req.json();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return c.json({ kind: "ValidationError" }, 400);
  }
  const payload = activityPayloadFromJson(raw as Record<string, unknown>);
  if (!payload) {
    return c.json({ kind: "UnknownType" }, 400);
  }
  const activityId = ActivityId.parse(payload.id);
  if (activityId.isErr()) {
    return c.json({ kind: "ValidationError" }, 400);
  }
  const known = await inboxActivityExists(c.env.DB, activityId.value);
  if (known.isErr()) {
    return jsonRepositoryError(c, known.error.message);
  }
  const bodyText = JSON.stringify(raw);
  if (c.req.header("Signature")) {
    const actorUsername = parseLocalActorUsername(identity.value, String(payload.actor));
    const actor = actorUsername
      ? await findAccountByUsername(c.env.DB, actorUsername)
      : undefined;
    if (actor && actor.isOk() && actor.value) {
      const ok = await verifyInboxRequest(c.req.raw, actor.value.publicKeyPem, bodyText);
      if (!ok) {
        return c.json({ kind: "InvalidSignature" }, 401);
      }
    }
  }
  const received = InboxActivity.dispatch(
    { kind: "Received", activityId: activityId.value, payload },
    known.value ? new Set([activityId.value]) : new Set(),
  );
  if (received.kind === "Duplicate") {
    return c.body(null, 202);
  }
  if (received.kind === "Rejected") {
    await insertInboxActivity(c.env.DB, {
      activityId: activityId.value,
      kind: received.error.kind,
      payload: raw,
    });
    return c.json(received.error, 400);
  }
  await insertInboxActivity(c.env.DB, {
    activityId: activityId.value,
    kind: received.kind === "Dispatched" ? received.activity.kind : "Received",
    payload: raw,
  });
  if (received.kind !== "Dispatched") {
    return c.body(null, 202);
  }
  const activity = received.activity;
  const actorUsername = parseLocalActorUsername(identity.value, activity.actor);
  const actorAccount = actorUsername
    ? await findAccountByUsername(c.env.DB, actorUsername)
    : undefined;
  if (activity.kind === "Follow") {
    const targetUsername = parseLocalActorUsername(identity.value, activity.object);
    const target = targetUsername
      ? await findAccountByUsername(c.env.DB, targetUsername)
      : undefined;
    if (target?.isOk() && target.value && actorAccount?.isOk() && actorAccount.value) {
      const followed = await followAccount(
        c.env.DB,
        actorAccount.value.id,
        target.value.id,
        target.value.locked,
      );
      if (followed.isOk() && followed.value.kind === "LocalFollower" && followed.value.follow.kind !== "None") {
        await insertNotification(c.env.DB, {
          accountId: target.value.id,
          fromAccountId: actorAccount.value.id,
          kind: followed.value.follow.kind === "Pending" ? "follow_request" : "follow",
        });
      }
    }
  }
  if (activity.kind === "Undo") {
    const targetUsername = parseLocalActorUsername(identity.value, activity.object);
    const target = targetUsername
      ? await findAccountByUsername(c.env.DB, targetUsername)
      : undefined;
    if (target?.isOk() && target.value && actorAccount?.isOk() && actorAccount.value) {
      await unfollowAccount(c.env.DB, actorAccount.value.id, target.value.id);
    }
  }
  if (activity.kind === "Like") {
    const statusId = parseLocalStatusId(identity.value, activity.object);
    if (statusId && actorAccount?.isOk() && actorAccount.value) {
      await favouriteStatus(c.env.DB, actorAccount.value.id, statusId);
    }
  }
  if (activity.kind === "Announce") {
    const statusId = parseLocalStatusId(identity.value, activity.object);
    const parsedStatusId = statusId ? StatusId.parse(statusId) : undefined;
    if (
      parsedStatusId?.isOk() &&
      actorAccount?.isOk() &&
      actorAccount.value
    ) {
      const reblogId = StatusId.parse(newEntityId());
      if (reblogId.isOk()) {
        await insertLocalReblog(
          c.env.DB,
          LocalStatus.reblog(
            reblogId.value,
            actorAccount.value.id,
            parsedStatusId.value,
            nowInstant(),
          ),
        );
      }
    }
  }
  return c.body(null, 202);
};

activityPubRoutes.post("/users/:username/inbox", (c) => handleInbox(c));
activityPubRoutes.post("/inbox", (c) => handleInbox(c));
