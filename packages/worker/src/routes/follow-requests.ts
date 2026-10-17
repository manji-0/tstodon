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
import { RemoteAccountId } from "../remote-account-id";
import {
  authorizeFollowRequest,
  listPendingFollowRequesters,
  rejectFollowRequest,
  relationshipFlags,
  type RelationshipFlags,
} from "../social-store";

export const followRequestRoutes = new Hono<{ Bindings: Env }>();

const notFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

/** A remote follower has no local relationship rows, so only followed_by is known. */
const remoteFollowerFlags = (followedBy: boolean): RelationshipFlags => ({
  following: false,
  followedBy,
  requested: false,
  blocking: false,
  blockedBy: false,
  muting: false,
  mutingNotifications: false,
  mutingExpiresAt: null,
  endorsed: false,
  note: "",
});

/** Resolve a follow request target id to a local account or a remote actor uri. */
const localRequester = async (c: Context<{ Bindings: Env }>, id: string) => {
  const account = await findAccountById(c.env.DB, id);
  if (account.isErr()) {
    return { kind: "error" as const, message: account.error.message };
  }
  return { kind: "local" as const, account: account.value };
};

/** Resolve a path id to a remote actor via the reversible `r_` account id. */
const remoteRequester = async (c: Context<{ Bindings: Env }>, id: string) => {
  const actorUri = RemoteAccountId.decode(id);
  if (actorUri.isErr()) {
    return { kind: "notFound" as const };
  }
  const actor = await findRemoteActorByUri(c.env.DB, actorUri.value);
  if (actor.isErr()) {
    return { kind: "error" as const, message: actor.error.message };
  }
  if (!actor.value) {
    return { kind: "notFound" as const };
  }
  return { kind: "remote" as const, actor: actor.value, actorUri: actorUri.value };
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

  const remote = await remoteRequester(c, id);
  if (remote.kind === "notFound") {
    return notFound(c);
  }
  if (remote.kind === "error") {
    return jsonRepositoryError(c, remote.message);
  }
  const followActivityId = await findPendingRemoteFollowRequest(
    c.env.DB,
    user.value.id,
    remote.actorUri,
  );
  if (followActivityId.isErr()) {
    return jsonRepositoryError(c, followActivityId.error.message);
  }
  const authorized = await authorizeRemoteFollowRequest(c.env.DB, user.value.id, remote.actorUri);
  if (authorized.isErr()) {
    return jsonRepositoryError(c, authorized.error.message);
  }
  if (!authorized.value) {
    return notFound(c);
  }
  const acceptActor = InstanceIdentity.actorUrl(identity.value, user.value.username);
  if (followActivityId.value) {
    const followerInbox = RemoteActor.deliveryInbox(remote.actor);
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
          actor: remote.actorUri,
          object: acceptActor,
        },
      },
      followerInbox,
    );
  }
  return c.json(mastodonRelationship(id, remoteFollowerFlags(true)));
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

  const remote = await remoteRequester(c, id);
  if (remote.kind === "notFound") {
    return notFound(c);
  }
  if (remote.kind === "error") {
    return jsonRepositoryError(c, remote.message);
  }
  const followActivityId = await findPendingRemoteFollowRequest(
    c.env.DB,
    user.value.id,
    remote.actorUri,
  );
  if (followActivityId.isErr()) {
    return jsonRepositoryError(c, followActivityId.error.message);
  }
  const rejected = await rejectRemoteFollowRequest(c.env.DB, user.value.id, remote.actorUri);
  if (rejected.isErr()) {
    return jsonRepositoryError(c, rejected.error.message);
  }
  if (!rejected.value) {
    return notFound(c);
  }
  const rejectActor = InstanceIdentity.actorUrl(identity.value, user.value.username);
  if (followActivityId.value) {
    const followerInbox = RemoteActor.deliveryInbox(remote.actor);
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
          actor: remote.actorUri,
          object: rejectActor,
        },
      },
      followerInbox,
    );
  }
  return c.json(mastodonRelationship(id, remoteFollowerFlags(false)));
});
