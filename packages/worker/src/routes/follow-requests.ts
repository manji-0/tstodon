import { InstanceIdentity, RemoteActor } from "@tstodon/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import { findAccountById } from "../account-store";
import { enqueueTargetedActivity } from "../delivery";
import { jsonAuthError, jsonRepositoryError, queryLimit, requireUser } from "../http";
import { mastodonAccountDocument, mastodonRelationship, mastodonRemoteAccount } from "../mastodon";
import {
  authorizeRemoteFollowRequest,
  findPendingRemoteFollowRequest,
  findRemoteActorByUri,
  listPendingRemoteFollowRequesters,
  rejectRemoteFollowRequest,
} from "../remote-actor-store";
import { parseInstanceIdentity } from "../runtime-config";
import {
  authorizeFollowRequest,
  listPendingFollowRequesters,
  rejectFollowRequest,
  relationshipFlags,
} from "../social-store";

export const followRequestRoutes = new Hono<{ Bindings: Env }>();

const notFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

/** Resolve a follow request target id to a local account or a remote actor uri. */
const localRequester = async (c: Context<{ Bindings: Env }>, id: string) => {
  const account = await findAccountById(c.env.DB, id);
  if (account.isErr()) {
    return { kind: "error" as const, message: account.error.message };
  }
  return { kind: "local" as const, account: account.value };
};

followRequestRoutes.get("/api/v1/follow_requests", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const limit = queryLimit(c.req.query("limit"), 40);
  const [local, remote] = await Promise.all([
    listPendingFollowRequesters(c.env.DB, user.value.id, limit),
    listPendingRemoteFollowRequesters(c.env.DB, user.value.id, limit),
  ]);
  if (local.isErr()) {
    return jsonRepositoryError(c, local.error.message);
  }
  if (remote.isErr()) {
    return jsonRepositoryError(c, remote.error.message);
  }

  type Entry = Readonly<{ createdAt: string; document: Record<string, unknown> }>;
  const entries: Entry[] = [];
  for (const requester of local.value) {
    const account = await findAccountById(c.env.DB, requester.followerAccountId);
    if (account.isOk() && account.value) {
      entries.push({
        createdAt: requester.createdAt,
        document: await mastodonAccountDocument(c.env, identity.value, account.value),
      });
    }
  }
  for (const requester of remote.value) {
    const actor = await findRemoteActorByUri(c.env.DB, requester.remoteActorUri);
    if (actor.isOk() && actor.value) {
      entries.push({
        createdAt: requester.createdAt,
        document: mastodonRemoteAccount(identity.value, actor.value),
      });
    }
  }
  entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return c.json(entries.map((entry) => entry.document));
});

followRequestRoutes.post("/api/v1/follow_requests/:id/authorize", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const id = c.req.param("id") ?? "";

  const local = await localRequester(c, id);
  if (local.kind === "error") {
    return jsonRepositoryError(c, local.message);
  }
  if (local.account) {
    const authorized = await authorizeFollowRequest(c.env.DB, user.value.id, local.account.id);
    if (authorized.isErr()) {
      return jsonRepositoryError(c, authorized.error.message);
    }
    if (!authorized.value) {
      return notFound(c);
    }
    const flags = await relationshipFlags(c.env.DB, user.value.id, local.account.id);
    if (flags.isErr()) {
      return jsonRepositoryError(c, flags.error.message);
    }
    return c.json(mastodonRelationship(local.account.id, flags.value));
  }

  const actor = await findRemoteActorByUri(c.env.DB, id);
  if (actor.isErr()) {
    return jsonRepositoryError(c, actor.error.message);
  }
  if (!actor.value) {
    return notFound(c);
  }
  const followActivityId = await findPendingRemoteFollowRequest(c.env.DB, user.value.id, id);
  if (followActivityId.isErr()) {
    return jsonRepositoryError(c, followActivityId.error.message);
  }
  const authorized = await authorizeRemoteFollowRequest(c.env.DB, user.value.id, id);
  if (authorized.isErr()) {
    return jsonRepositoryError(c, authorized.error.message);
  }
  if (!authorized.value) {
    return notFound(c);
  }
  const acceptActor = InstanceIdentity.actorUrl(identity.value, user.value.username);
  if (followActivityId.value) {
    const followerInbox = RemoteActor.deliveryInbox(actor.value);
    await enqueueTargetedActivity(
      c.env,
      user.value.id,
      "Accept",
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${acceptActor}/activities/accept-${followActivityId.value}`,
        type: "Accept",
        actor: acceptActor,
        object: {
          id: followActivityId.value,
          type: "Follow",
          actor: actor.value.actorUri,
          object: acceptActor,
        },
      },
      followerInbox,
    );
  }
  return c.json(mastodonRelationship(id, { following: false, followedBy: true, requested: false }));
});

followRequestRoutes.post("/api/v1/follow_requests/:id/reject", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const id = c.req.param("id") ?? "";

  const local = await localRequester(c, id);
  if (local.kind === "error") {
    return jsonRepositoryError(c, local.message);
  }
  if (local.account) {
    const rejected = await rejectFollowRequest(c.env.DB, user.value.id, local.account.id);
    if (rejected.isErr()) {
      return jsonRepositoryError(c, rejected.error.message);
    }
    if (!rejected.value) {
      return notFound(c);
    }
    const flags = await relationshipFlags(c.env.DB, user.value.id, local.account.id);
    if (flags.isErr()) {
      return jsonRepositoryError(c, flags.error.message);
    }
    return c.json(mastodonRelationship(local.account.id, flags.value));
  }

  const actor = await findRemoteActorByUri(c.env.DB, id);
  if (actor.isErr()) {
    return jsonRepositoryError(c, actor.error.message);
  }
  if (!actor.value) {
    return notFound(c);
  }
  const followActivityId = await findPendingRemoteFollowRequest(c.env.DB, user.value.id, id);
  if (followActivityId.isErr()) {
    return jsonRepositoryError(c, followActivityId.error.message);
  }
  const rejected = await rejectRemoteFollowRequest(c.env.DB, user.value.id, id);
  if (rejected.isErr()) {
    return jsonRepositoryError(c, rejected.error.message);
  }
  if (!rejected.value) {
    return notFound(c);
  }
  const rejectActor = InstanceIdentity.actorUrl(identity.value, user.value.username);
  if (followActivityId.value) {
    const followerInbox = RemoteActor.deliveryInbox(actor.value);
    await enqueueTargetedActivity(
      c.env,
      user.value.id,
      "Reject",
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${rejectActor}/activities/reject-${followActivityId.value}`,
        type: "Reject",
        actor: rejectActor,
        object: {
          id: followActivityId.value,
          type: "Follow",
          actor: actor.value.actorUri,
          object: rejectActor,
        },
      },
      followerInbox,
    );
  }
  return c.json(
    mastodonRelationship(id, { following: false, followedBy: false, requested: false }),
  );
});
