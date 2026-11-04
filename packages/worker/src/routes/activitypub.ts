import {
  ActivityId,
  InboxActivity,
  InstanceIdentity,
  LocalStatus,
  RemoteActor,
  StatusId,
  StatusTarget,
  Visibility,
  reblogVisibility,
  type LocalAccount,
  type RemoteActor as RemoteActorValue,
} from "@tstodon/domain";
import type { Context } from "hono";
import { findAccountByUsername, findAccountsByIds } from "../account-store";
import {
  activityPayloadFromJson,
  noteDocument,
  parseLocalActorUsername,
  parseLocalStatusId,
} from "../activitypub";
import { jsonRepositoryError, queryLimit } from "../http";
import { verifyInboxRequest, parseSignatureHeader } from "../http-signature";
import { localActorDocument } from "../local-actor";
import { suspendedDomains } from "../admin-domain-block-store";
import { getRemoteActorModeration } from "../remote-actor-moderation-store";
import { signedFetchActor } from "../signed-fetch";
import { inboxActivityExists, insertInboxActivity } from "../inbox-store";
import { listPublicOutboxActivities } from "../outbox-store";
import { resolveRemoteActor } from "../remote-actor-fetch";
import {
  deleteRemoteFollow,
  findRemoteActorByUri,
  findRemoteFollow,
  purgeRemoteActor,
  upsertRemoteFollow,
} from "../remote-actor-store";
import { RemoteDeleteTarget } from "../remote-delete";
import { applyRemoteUpdate } from "../remote-update";
import { persistAnnouncedObject, persistRemoteObject } from "../remote-status-persist";
import { enqueueHomeFanOut } from "../home-fan-out";
import { enqueuePublicFanOut } from "../public-fan-out";
import { recordRemoteBoost } from "../remote-boost";
import { deleteRemoteBoostByActivity } from "../remote-boost-store";
import { handleRemotePollVote } from "../remote-poll-vote";
import { deleteRemoteStatusByObjectUri } from "../remote-status-store";
import {
  deleteRemoteAnnounce,
  deleteRemoteFavourite,
  upsertRemoteAnnounce,
  upsertRemoteFavourite,
} from "../remote-interaction-store";
import { enqueueTargetedActivity } from "../delivery";
import { allowListAdmits, federationAllowHosts, parseInstanceIdentity } from "../runtime-config";
import { quotedStatusUri } from "../quote-uri";
import {
  ActivityJsonSchema,
  JsonObjectSchema,
  NestedActivityObjectSchema,
} from "../activitypub-wire";
import { parseJsonColumn, parseJsonText } from "../json-column";
import { schemaResult } from "@tstodon/core";
import { deleteRemoteNotifications } from "../notification-store";
import { favouriteStatus } from "../status-interaction-store";
import { followAccount, listFollowers, listFollowing, unfollowAccount } from "../follow-store";
import { loadNoteMentions } from "../mention-resolve";
import { loadNoteReply } from "../reply-target";
import { loadNotePoll } from "../poll-store";
import { notifyAccount, notifyFromRemote } from "../notify";
import { findStatusById, insertLocalReblog } from "../status-store";
import { nowInstant } from "../clock";
import { newEntityId } from "../ids";
import { outboundFollowAnswer } from "../outbound-follow";
import { acceptOutboundFollow, rejectOutboundFollow } from "../outbound-follow-store";
import { RemoteAccountId } from "../remote-account-id";
import { applyRemoteMove } from "../remote-move";
import { receiveRemoteFlag } from "../remote-flag";
import { instanceActorDocument, instanceActorKeys } from "../instance-actor";

const parseNestedActivityObject = schemaResult(NestedActivityObjectSchema);
const parseActivityJson = schemaResult(ActivityJsonSchema);

const jsonLd = {
  "content-type": "application/activity+json",
};

export const getUsersByUsername = async (c: Context<{ Bindings: Env }, "/users/:username">) => {
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
  const document = await localActorDocument(c.env.DB, identity.value, account.value);
  if (document.isErr()) {
    return jsonRepositoryError(c, document.error.message);
  }
  return c.json(document.value, 200, jsonLd);
};

export const getUsersByUsernameStatusesById = async (
  c: Context<{ Bindings: Env }, "/users/:username/statuses/:id">,
) => {
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
  if (
    !status.value ||
    status.value.kind !== "LocalNote" ||
    status.value.accountId !== account.value.id
  ) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const note = noteDocument(identity.value, account.value, status.value, {
    quoteUri: await quotedStatusUri(c.env, identity.value, status.value.id),
    mentions: await loadNoteMentions(c.env.DB, identity.value, status.value.id),
    reply: await loadNoteReply(c.env.DB, identity.value, status.value),
    poll: await loadNotePoll(c.env.DB, status.value.id),
  });
  const visibility = status.value.visibility.kind;
  if (visibility !== "Public" && visibility !== "Unlisted") {
    // Followers-only and direct notes go to a signed fetch from an actor they
    // address (Mastodon's authorized fetch), and never into a shared cache.
    const signer = await signedFetchActor(c.env, identity.value, c.req.raw);
    if (!signer || !(await noteAddresses(c.env.DB, note, account.value, signer.actorUri))) {
      return c.json({ kind: "NotFound" }, 404);
    }
    c.header("Cache-Control", "private");
    c.header("Vary", "Signature");
  }
  return c.json(note, 200, jsonLd);
};

/**
 * Does the note's audience include this remote actor: named in `to`/`cc`, or an
 * accepted follower when the author's followers collection is addressed?
 */
const noteAddresses = async (
  db: D1Database,
  note: Readonly<Record<string, unknown>>,
  author: LocalAccount,
  actorUri: string,
): Promise<boolean> => {
  const audience = [note.to, note.cc].flatMap((field) =>
    Array.isArray(field) ? field.filter((uri) => typeof uri === "string") : [],
  );
  if (audience.includes(actorUri)) {
    return true;
  }
  if (!audience.includes(`${String(note.attributedTo)}/followers`)) {
    return false;
  }
  const follow = await findRemoteFollow(db, author.id, actorUri);
  return follow.isOk() && follow.value?.requestKind === "Fulfilled";
};

const collection = (id: string, items: ReadonlyArray<string>) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id,
  type: "OrderedCollection",
  totalItems: items.length,
  orderedItems: items,
});

export const getUsersByUsernameOutbox = async (
  c: Context<{ Bindings: Env }, "/users/:username/outbox">,
) => {
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
  // What anyone may read, as in Mastodon: public or unlisted notes and boosts.
  // The query filters before its LIMIT, so a page is not cut short.
  const rows = await listPublicOutboxActivities(
    c.env.DB,
    account.value.id,
    queryLimit(c.req.query("limit"), 20),
  );
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  const actor = InstanceIdentity.actorUrl(identity.value, account.value.username);
  const items = rows.value.flatMap((row) => {
    const payload = parseJsonColumn(JsonObjectSchema, row.payload_json);
    return payload.isOk() ? [payload.value] : [];
  });
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
};

export const getUsersByUsernameFollowers = async (
  c: Context<{ Bindings: Env }, "/users/:username/followers">,
) => {
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
  const followers = await findAccountsByIds(
    c.env.DB,
    ids.value.map((edge) => edge.accountId),
  );
  const items = ids.value.flatMap((edge) => {
    const remote = RemoteAccountId.decode(edge.accountId);
    if (remote.isOk()) {
      return [remote.value];
    }
    const follower = followers.isOk() ? followers.value.get(edge.accountId) : undefined;
    return follower ? [InstanceIdentity.actorUrl(identity.value, follower.username)] : [];
  });
  const actor = InstanceIdentity.actorUrl(identity.value, account.value.username);
  return c.json(collection(`${actor}/followers`, items), 200, jsonLd);
};

export const getUsersByUsernameFollowing = async (
  c: Context<{ Bindings: Env }, "/users/:username/following">,
) => {
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
  const targets = await findAccountsByIds(
    c.env.DB,
    ids.value.map((edge) => edge.accountId),
  );
  const items = ids.value.flatMap((edge) => {
    const remote = RemoteAccountId.decode(edge.accountId);
    if (remote.isOk()) {
      return [remote.value];
    }
    const target = targets.isOk() ? targets.value.get(edge.accountId) : undefined;
    return target ? [InstanceIdentity.actorUrl(identity.value, target.username)] : [];
  });
  const actor = InstanceIdentity.actorUrl(identity.value, account.value.username);
  return c.json(collection(`${actor}/following`, items), 200, jsonLd);
};

const objectUriOf = (value: string | Readonly<{ id: string }>): string =>
  typeof value === "string" ? value : value.id;

const nestedActivityTarget = (raw: unknown): { type: string; objectUri: string } | undefined => {
  const parsed = parseNestedActivityObject(raw);
  if (parsed.isErr()) {
    return undefined;
  }
  return { type: parsed.value.type, objectUri: objectUriOf(parsed.value.object) };
};

const handleInbox = async (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const bodyText = await c.req.text();
  const json = parseJsonText(bodyText);
  if (json.isErr()) {
    return c.json({ kind: "ValidationError" }, 400);
  }
  const activityJson = parseActivityJson(json.value);
  if (activityJson.isErr()) {
    return c.json({ kind: "ValidationError" }, 400);
  }
  const signature = parseSignatureHeader(c.req.header("Signature") ?? "");
  if (!signature) {
    return c.json({ kind: "InvalidSignature" }, 401);
  }
  const suspended = await suspendedDomains(c.env.DB);
  const payload = activityPayloadFromJson(activityJson.value);
  const actorUri = String(payload.actor);
  const actorUsername = parseLocalActorUsername(identity.value, actorUri);
  const deleteTarget = RemoteDeleteTarget.of(actorUri, String(payload.object));
  let signer:
    | { kind: "Local"; account: LocalAccount }
    | { kind: "Remote"; actor: RemoteActorValue };
  if (actorUsername) {
    const actorAccount = await findAccountByUsername(c.env.DB, actorUsername);
    if (actorAccount.isErr()) {
      return jsonRepositoryError(c, actorAccount.error.message);
    }
    if (!actorAccount.value) {
      return c.json({ kind: "InvalidSignature" }, 401);
    }
    signer = { kind: "Local", account: actorAccount.value };
  } else {
    // A repeated account Delete from an actor already purged: there is nothing
    // to remove and its key can no longer be fetched.
    if (payload.kind === "Delete" && deleteTarget.kind === "ActorDelete") {
      const cached = await findRemoteActorByUri(c.env.DB, actorUri);
      if (cached.isErr()) {
        return jsonRepositoryError(c, cached.error.message);
      }
      if (!cached.value) {
        return c.body(null, 202);
      }
    }
    const allowHosts = await federationAllowHosts(c.env);
    const remote = await resolveRemoteActor(c.env.DB, identity.value, signature.keyId, actorUri, {
      allowHosts,
      blockedHosts: suspended,
    });
    if (remote.isErr()) {
      if (remote.error.kind === "VerificationUnavailable") {
        c.header("Retry-After", "5");
        return c.json({ kind: "VerificationUnavailable" }, 503);
      }
      if (remote.error.kind === "RepositoryError") {
        return jsonRepositoryError(c, remote.error.message);
      }
      return c.json({ kind: "InvalidSignature" }, 401);
    }
    // Limited federation: an actor outside the allow list never federates here.
    const remoteHost = remote.value.domain.toLowerCase();
    if (suspended.has(remoteHost) || !allowListAdmits(allowHosts, remoteHost)) {
      return c.json(
        { error: "This instance does not federate with that domain", kind: "Forbidden" },
        403,
      );
    }
    // An admin suspended this actor: nothing it sends is processed, except
    // the deletion of its own account.
    const moderation = await getRemoteActorModeration(c.env.DB, remote.value.actorUri);
    if (moderation.isErr()) {
      return jsonRepositoryError(c, moderation.error.message);
    }
    if (
      moderation.value.standing.kind === "Suspended" &&
      !(payload.kind === "Delete" && deleteTarget.kind === "ActorDelete")
    ) {
      return c.json({ error: "This actor is suspended on this instance", kind: "Forbidden" }, 403);
    }
    signer = { kind: "Remote", actor: remote.value };
  }
  const publicKeyPem =
    signer.kind === "Local" ? signer.account.publicKeyPem : signer.actor.publicKeyPem;
  const verified = await verifyInboxRequest(c.req.raw, publicKeyPem, bodyText);
  if (!verified) {
    return c.json({ kind: "InvalidSignature" }, 401);
  }
  const activityId = ActivityId.parse(payload.id);
  if (activityId.isErr()) {
    return c.json({ kind: "ValidationError" }, 400);
  }
  const known = await inboxActivityExists(c.env.DB, activityId.value);
  if (known.isErr()) {
    return jsonRepositoryError(c, known.error.message);
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
      payload: activityJson.value,
    });
    return c.json(received.error, 400);
  }
  await insertInboxActivity(c.env.DB, {
    activityId: activityId.value,
    kind: received.kind === "Dispatched" ? received.activity.kind : "Received",
    payload: activityJson.value,
  });
  if (received.kind !== "Dispatched") {
    return c.body(null, 202);
  }
  const activity = received.activity;
  if (signer.kind === "Remote") {
    // The actor answers a local account's `Follow` of it.
    if (activity.kind === "Accept" || activity.kind === "Reject") {
      const answer = await outboundFollowAnswer(
        c.env.DB,
        identity.value,
        signer.actor,
        activity.object,
        activityJson.value.object,
      );
      if (answer.isErr()) {
        return jsonRepositoryError(c, answer.error.message);
      }
      const answered =
        activity.kind === "Accept"
          ? await acceptOutboundFollow(c.env.DB, answer.value)
          : await rejectOutboundFollow(c.env.DB, answer.value);
      if (answered.isErr()) {
        return jsonRepositoryError(c, answered.error.message);
      }
    }
    if (activity.kind === "Flag") {
      const flagged = await receiveRemoteFlag(c.env, identity.value, signer.actor, json.value);
      if (flagged.isErr()) {
        return jsonRepositoryError(c, flagged.error.message);
      }
    }
    if (activity.kind === "Move") {
      const moved = await applyRemoteMove(c.env, identity.value, signer.actor, activityJson.value, {
        allowHosts: await federationAllowHosts(c.env),
        blockedHosts: suspended,
      });
      if (moved.isErr()) {
        return jsonRepositoryError(c, moved.error.message);
      }
    }
    if (activity.kind === "Follow") {
      const targetUsername = parseLocalActorUsername(identity.value, activity.object);
      const target = targetUsername
        ? await findAccountByUsername(c.env.DB, targetUsername)
        : undefined;
      if (target?.isOk() && target.value) {
        // A redelivered Follow keeps its row and must not notify again.
        const existing = await findRemoteFollow(c.env.DB, target.value.id, signer.actor.actorUri);
        const followed = await upsertRemoteFollow(
          c.env.DB,
          signer.actor.actorUri,
          target.value.id,
          target.value.locked,
          activity.id,
        );
        if (followed.isOk() && existing.isOk() && !existing.value) {
          await notifyFromRemote(c.env, {
            accountId: target.value.id,
            actorUri: signer.actor.actorUri,
            kind: target.value.locked ? "follow_request" : "follow",
          });
        }
        // Unlocked accounts auto-accept: send Accept to the follower's inbox.
        if (!target.value.locked) {
          const acceptActor = InstanceIdentity.actorUrl(identity.value, target.value.username);
          const followerInbox = RemoteActor.deliveryInbox(signer.actor);
          await enqueueTargetedActivity(
            c.env,
            target.value.id,
            "Accept",
            {
              "@context": "https://www.w3.org/ns/activitystreams",
              id: `${acceptActor}/activities/accept-${activity.id}`,
              type: "Accept",
              actor: acceptActor,
              object: {
                id: activity.id,
                type: "Follow",
                actor: signer.actor.actorUri,
                object: activity.object,
              },
            },
            followerInbox,
          );
        }
      }
    }
    if (activity.kind === "Undo") {
      const nested = nestedActivityTarget(activityJson.value.object);
      const targetUsername = parseLocalActorUsername(
        identity.value,
        nested?.type === "Follow" ? nested.objectUri : activity.object,
      );
      const target = targetUsername
        ? await findAccountByUsername(c.env.DB, targetUsername)
        : undefined;
      if (target?.isOk() && target.value) {
        await deleteRemoteFollow(c.env.DB, signer.actor.actorUri, target.value.id);
        await deleteRemoteNotifications(c.env.DB, {
          actorUri: signer.actor.actorUri,
          kinds: ["follow", "follow_request"],
          accountId: target.value.id,
        });
      }
      const statusUri =
        nested && (nested.type === "Like" || nested.type === "Announce")
          ? nested.objectUri
          : undefined;
      const statusId = statusUri ? parseLocalStatusId(identity.value, statusUri) : undefined;
      if (statusId && nested?.type === "Like") {
        await deleteRemoteFavourite(c.env.DB, signer.actor.actorUri, statusId);
        await deleteRemoteNotifications(c.env.DB, {
          actorUri: signer.actor.actorUri,
          kinds: ["favourite"],
          statusId,
        });
      }
      // The boost row is keyed by the Announce id, whether the Undo embeds it or names it.
      const undone = await deleteRemoteBoostByActivity(
        c.env.DB,
        objectUriOf(activityJson.value.object),
        signer.actor.actorUri,
      );
      if (undone.isErr()) {
        return jsonRepositoryError(c, undone.error.message);
      }
      if (undone.value) {
        await enqueueHomeFanOut(c.env, {
          event: "delete",
          entryId: undone.value,
          author: { kind: "RemoteActor", actorUri: signer.actor.actorUri },
        });
      }
      if (statusId && nested?.type === "Announce") {
        await deleteRemoteAnnounce(c.env.DB, signer.actor.actorUri, statusId);
        await deleteRemoteNotifications(c.env.DB, {
          actorUri: signer.actor.actorUri,
          kinds: ["reblog"],
          statusId,
        });
      }
    }
    if (activity.kind === "Like") {
      const statusId = parseLocalStatusId(identity.value, activity.object);
      if (statusId) {
        const liked = await upsertRemoteFavourite(c.env.DB, signer.actor.actorUri, statusId);
        if (liked.isOk() && liked.value) {
          await notifyStatusAuthor(c.env, signer.actor.actorUri, statusId, "favourite");
        }
      }
    }
    if (activity.kind === "Delete") {
      if (deleteTarget.kind === "ActorDelete") {
        const purged = await purgeRemoteActor(c.env.DB, deleteTarget.actorUri);
        if (purged.isErr()) {
          return jsonRepositoryError(c, purged.error.message);
        }
      } else if (!parseLocalStatusId(identity.value, deleteTarget.objectUri)) {
        // Remote note delete (object is remote URI we may have cached).
        const deleted = await deleteRemoteStatusByObjectUri(
          c.env.DB,
          deleteTarget.objectUri,
          signer.actor.actorUri,
        );
        // Its mention notifications go with it.
        if (deleted.isOk() && deleted.value) {
          await enqueueHomeFanOut(c.env, {
            event: "delete",
            entryId: deleted.value.id,
            author: { kind: "RemoteActor", actorUri: signer.actor.actorUri },
          });
          if (deleted.value.public) {
            await enqueuePublicFanOut(c.env, { event: "delete", entryId: deleted.value.id });
          }
          await deleteRemoteNotifications(c.env.DB, {
            actorUri: signer.actor.actorUri,
            kinds: ["mention"],
            statusId: deleted.value.id,
          });
        }
      }
    }
    if (activity.kind === "Update") {
      await applyRemoteUpdate(c.env, identity.value, signer.actor, activityJson.value.object, {
        allowHosts: await federationAllowHosts(c.env),
      });
    }
    const pollVote =
      activity.kind === "Create"
        ? await handleRemotePollVote(c.env, identity.value, signer.actor, activityJson.value.object)
        : undefined;
    if (pollVote?.kind === "NotAVote") {
      const created = await persistRemoteObject(
        c.env,
        identity.value,
        signer.actor,
        activityJson.value.object,
        { allowHosts: await federationAllowHosts(c.env), notifyMentions: true },
      );
      // A redelivered Create finds the note cached and tells followers again,
      // which clients take as the same status.
      if (created.isOk() && created.value?.actorUri === signer.actor.actorUri) {
        await enqueueHomeFanOut(c.env, {
          event: "update",
          entryId: created.value.id,
          author: { kind: "RemoteActor", actorUri: signer.actor.actorUri },
        });
        if (created.value.visibility.kind === "Public") {
          await enqueuePublicFanOut(c.env, { event: "update", entryId: created.value.id });
        }
      }
    }
    if (activity.kind === "Announce") {
      const announced = await persistAnnouncedObject(
        c.env,
        identity.value,
        signer.actor,
        activityJson.value.object,
        { allowHosts: await federationAllowHosts(c.env), blockedHosts: suspended },
      );
      if (announced.isErr()) {
        return jsonRepositoryError(c, announced.error.message);
      }
      const boosted = await recordRemoteBoost(
        c.env.DB,
        identity.value,
        signer.actor.actorUri,
        activity,
        activityJson.value,
        announced.value,
      );
      if (boosted.isErr()) {
        return jsonRepositoryError(c, boosted.error.message);
      }
      if (boosted.value) {
        await enqueueHomeFanOut(c.env, {
          event: "update",
          entryId: boosted.value.id,
          author: { kind: "RemoteActor", actorUri: signer.actor.actorUri },
        });
      }
      const statusId = parseLocalStatusId(identity.value, activity.object);
      if (statusId) {
        const counted = await upsertRemoteAnnounce(
          c.env.DB,
          signer.actor.actorUri,
          statusId,
          activity.id,
        );
        if (counted.isOk() && counted.value) {
          await notifyStatusAuthor(c.env, signer.actor.actorUri, statusId, "reblog");
        }
      }
    }
    return c.body(null, 202);
  }
  const actor = signer.account;
  if (activity.kind === "Follow") {
    const targetUsername = parseLocalActorUsername(identity.value, activity.object);
    const target = targetUsername
      ? await findAccountByUsername(c.env.DB, targetUsername)
      : undefined;
    if (target?.isOk() && target.value) {
      const followed = await followAccount(
        c.env.DB,
        actor.id,
        target.value.id,
        target.value.locked,
      );
      if (
        followed.isOk() &&
        followed.value.kind === "LocalFollower" &&
        followed.value.follow.kind !== "None"
      ) {
        await notifyAccount(c.env, {
          accountId: target.value.id,
          fromAccountId: actor.id,
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
    if (target?.isOk() && target.value) {
      await unfollowAccount(c.env.DB, actor.id, target.value.id);
    }
  }
  if (activity.kind === "Like") {
    const statusId = StatusId.parse(parseLocalStatusId(identity.value, activity.object) ?? "");
    if (statusId.isOk()) {
      await favouriteStatus(c.env.DB, actor.id, StatusTarget.local(statusId.value));
    }
  }
  if (activity.kind === "Announce") {
    const statusId = parseLocalStatusId(identity.value, activity.object);
    const parsedStatusId = statusId ? StatusId.parse(statusId) : undefined;
    if (parsedStatusId?.isOk()) {
      // The boost shares the original's visibility when that one is restricted.
      const target = await findStatusById(c.env.DB, parsedStatusId.value);
      const reblogId = StatusId.parse(newEntityId());
      if (reblogId.isOk() && target.isOk() && target.value) {
        await insertLocalReblog(
          c.env.DB,
          LocalStatus.reblog(
            reblogId.value,
            actor.id,
            StatusTarget.local(parsedStatusId.value),
            nowInstant(),
            reblogVisibility(target.value.visibility, undefined, Visibility.Public),
          ),
        );
      }
    }
  }
  return c.body(null, 202);
};

/** Tell a local status's author about a remote actor's Like or Announce of it. */
const notifyStatusAuthor = async (
  env: Env,
  actorUri: string,
  statusId: string,
  kind: "favourite" | "reblog",
): Promise<void> => {
  const status = await findStatusById(env.DB, statusId);
  if (status.isOk() && status.value?.kind === "LocalNote") {
    await notifyFromRemote(env, { accountId: status.value.accountId, actorUri, kind, statusId });
  }
};

export const postUsersByUsernameInbox = (c: Context<{ Bindings: Env }, "/users/:username/inbox">) =>
  handleInbox(c);
export const postInbox = (c: Context<{ Bindings: Env }, "/inbox">) => handleInbox(c);
export const postActorInbox = (c: Context<{ Bindings: Env }, "/actor/inbox">) => handleInbox(c);

/** Mastodon's instance actor document (`GET /actor`). */
export const getActor = async (c: Context<{ Bindings: Env }, "/actor">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const keys = await instanceActorKeys(c.env.DB);
  if (keys.isErr()) {
    return jsonRepositoryError(c, keys.error.message);
  }
  return c.json(instanceActorDocument(identity.value, keys.value.publicKeyPem), 200, jsonLd);
};
