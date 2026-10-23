import type { Context } from "hono";
import { warmSchemas } from "@tstodon/core";
import { InstanceIdentity, RemoteActor } from "@tstodon/domain";
import { findAccountByIdOrUsername } from "../../account-store";
import { enqueueTargetedActivity } from "../../delivery";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readOptionalBody,
  requireUser,
} from "../../http";
import { mastodonRelationship } from "../../relationship-document";
import {
  deleteRemoteFollow,
  findRemoteActorByUri,
  findRemoteFollow,
} from "../../remote-actor-store";
import { RemoteAccountId } from "../../remote-account-id";
import { parseInstanceIdentity } from "../../runtime-config";
import { followAccount, type FollowOptions, unfollowAccount } from "../../follow-store";
import { relationshipFlags } from "../../relationship-store";
import { notifyAccount } from "../../notify";
import { isTruthy, stringList } from "../../form-values";
import { z } from "zod";
import { booleanish } from "../../form-values";

/** `POST /api/v1/accounts/:id/follow` — Mastodon's per-follow options. */
export const FollowBodySchema = z.object({
  reblogs: booleanish,
  notify: booleanish,
  languages: z.union([z.array(z.string()), z.string()]).optional(),
});

export const postV1AccountsByIdFollow = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/:id/follow">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const target = await findAccountByIdOrUsername(c.env.DB, c.req.param("id") ?? "");
  if (target.isErr()) {
    return jsonRepositoryError(c, target.error.message);
  }
  if (!target.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (target.value.id === user.value.id) {
    return c.json({ error: "Cannot follow yourself", kind: "InvalidFollow" }, 400);
  }
  // Mastodon's follow options: `reblogs`, `notify`, and `languages[]`.
  const followBody = await readOptionalBody(c, FollowBodySchema);
  if (followBody.isErr()) {
    return jsonValidationError(c);
  }
  const languageValues = [
    ...(c.req.queries("languages[]") ?? []),
    ...(c.req.queries("languages") ?? []),
    ...stringList(followBody.value.languages),
  ]
    .map((language) => language.trim().toLowerCase())
    .filter((language) => /^[a-z]{2,3}(-[a-z0-9]+)?$/.test(language));
  // The options arrive as form data; query parameters are accepted too.
  const reblogsRaw = followBody.value.reblogs ?? c.req.query("reblogs");
  const notifyRaw = followBody.value.notify ?? c.req.query("notify");
  const followOptions: FollowOptions = {
    ...(reblogsRaw === undefined ? {} : { reblogs: isTruthy(reblogsRaw) }),
    ...(notifyRaw === undefined ? {} : { notify: isTruthy(notifyRaw) }),
    ...(c.req.queries("languages[]") === undefined &&
    c.req.queries("languages") === undefined &&
    followBody.value.languages === undefined
      ? {}
      : { languages: [...new Set(languageValues)] }),
  };
  const prior = await relationshipFlags(c.env.DB, user.value.id, target.value.id);
  const followed = await followAccount(
    c.env.DB,
    user.value.id,
    target.value.id,
    target.value.locked,
    followOptions,
  );
  if (followed.isErr()) {
    return jsonRepositoryError(c, followed.error.message);
  }
  const alreadyRelated = prior.isOk() && (prior.value.following || prior.value.requested);
  if (
    !alreadyRelated &&
    followed.value.kind === "LocalFollower" &&
    followed.value.follow.kind !== "None"
  ) {
    await notifyAccount(c.env, {
      accountId: target.value.id,
      fromAccountId: user.value.id,
      kind: followed.value.follow.kind === "Pending" ? "follow_request" : "follow",
    });
  }
  const flags = await relationshipFlags(c.env.DB, user.value.id, target.value.id);
  if (flags.isErr()) {
    return jsonRepositoryError(c, flags.error.message);
  }
  return c.json(mastodonRelationship(target.value.id, flags.value));
};

export const postV1AccountsByIdUnfollow = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/:id/unfollow">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const target = await findAccountByIdOrUsername(c.env.DB, c.req.param("id") ?? "");
  if (target.isErr()) {
    return jsonRepositoryError(c, target.error.message);
  }
  if (!target.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const unfollowed = await unfollowAccount(c.env.DB, user.value.id, target.value.id);
  if (unfollowed.isErr()) {
    return jsonRepositoryError(c, unfollowed.error.message);
  }
  const flags = await relationshipFlags(c.env.DB, user.value.id, target.value.id);
  if (flags.isErr()) {
    return jsonRepositoryError(c, flags.error.message);
  }
  return c.json(mastodonRelationship(target.value.id, flags.value));
};

export const postV1AccountsByIdRemoveFromFollowers = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/:id/remove_from_followers">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const targetId = c.req.param("id") ?? "";

  const local = await findAccountByIdOrUsername(c.env.DB, targetId);
  if (local.isErr()) {
    return jsonRepositoryError(c, local.error.message);
  }
  if (local.value) {
    const removed = await unfollowAccount(c.env.DB, local.value.id, user.value.id);
    if (removed.isErr()) {
      return jsonRepositoryError(c, removed.error.message);
    }
    const flags = await relationshipFlags(c.env.DB, user.value.id, local.value.id);
    if (flags.isErr()) {
      return jsonRepositoryError(c, flags.error.message);
    }
    return c.json(mastodonRelationship(local.value.id, flags.value));
  }

  const actorUri = RemoteAccountId.decode(targetId);
  if (actorUri.isErr()) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const actor = await findRemoteActorByUri(c.env.DB, actorUri.value);
  if (actor.isErr()) {
    return jsonRepositoryError(c, actor.error.message);
  }
  if (!actor.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const existing = await findRemoteFollow(c.env.DB, user.value.id, actorUri.value);
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  if (!existing.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const dropped = await deleteRemoteFollow(c.env.DB, actorUri.value, user.value.id);
  if (dropped.isErr()) {
    return jsonRepositoryError(c, dropped.error.message);
  }

  // Tell the remote follower it no longer follows; delivery is best effort.
  const actorUrl = InstanceIdentity.actorUrl(identity.value, user.value.username);
  const followObjectId = existing.value.followActivityId ?? actorUri.value;
  await enqueueTargetedActivity(
    c.env,
    user.value.id,
    "Reject",
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actorUrl}/activities/reject-${followObjectId}`,
      type: "Reject",
      actor: actorUrl,
      object: { id: followObjectId, type: "Follow", actor: actorUri.value, object: actorUrl },
    },
    RemoteActor.deliveryInbox(actor.value),
  );

  const flags = await relationshipFlags(c.env.DB, user.value.id, actorUri.value);
  if (flags.isErr()) {
    return jsonRepositoryError(c, flags.error.message);
  }
  return c.json(mastodonRelationship(targetId, flags.value));
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([FollowBodySchema]);
