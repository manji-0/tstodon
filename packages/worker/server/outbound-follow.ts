import type { ApFollowJSON } from "@tstodon/api/activitypub";
import {
  type AcceptOutboundFollow,
  type FindLocalAccountByUsername,
  type HoldsOutboundFollow,
  Hostname,
  InstanceIdentity,
  type LocalAccount,
  type OutboundFollowAnswer,
  type RejectOutboundFollow,
  RemoteActor,
} from "@tstodon/domain";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { parseLocalActorUsername } from "./activitypub";
import { suspendedDomains } from "./admin-domain-block-store";
import { findBlock } from "./block-mute-store";
import type { RepositoryError } from "./d1";
import { type EnqueueLocalActivityError, enqueueTargetedActivity } from "./delivery";
import { isActorDomainBlocked } from "./domain-block-store";
import type { FollowOptions } from "./follow-store";
import { newEntityId } from "./ids";
import {
  deleteOutboundFollow,
  insertOutboundFollow,
  updateOutboundFollowOptions,
} from "./outbound-follow-store";
import { allowListAdmits, federationAllowHosts } from "./runtime-config";

export type FollowRemoteActorError =
  | RepositoryError
  | Readonly<{ kind: "Blocked" }>
  | Readonly<{ kind: "DomainBlocked" }>
  | Readonly<{ kind: "NotFederated" }>;

const followActivity = (
  followerUrl: string,
  followActivityId: string,
  actorUri: string,
): ApFollowJSON => ({
  id: followActivityId,
  type: "Follow",
  actor: followerUrl,
  object: actorUri,
});

/**
 * Follow a cached remote actor: record the follow as `Requested` and send
 * the `Follow` to the actor's inbox. Following again while requested or
 * accepted only updates the options given; the `Follow` is not sent twice.
 */
export const followRemoteActor = async (
  env: Env,
  identity: InstanceIdentity,
  follower: LocalAccount,
  actor: RemoteActor,
  options: FollowOptions,
): Promise<Result<void, FollowRemoteActorError>> => {
  const hosts = [...RemoteActor.hostnames(actor), Hostname.ofUri(actor.inboxUri)].flatMap((host) =>
    host === undefined ? [] : [host],
  );
  const suspended = await suspendedDomains(env.DB);
  const allowHosts = await federationAllowHosts(env);
  if (hosts.some((host) => suspended.has(host) || !allowListAdmits(allowHosts, host))) {
    return err({ kind: "NotFederated" });
  }
  const blocked = await findBlock(env.DB, follower.id, actor.actorUri);
  if (blocked.isErr()) {
    return err(blocked.error);
  }
  if (blocked.value) {
    return err({ kind: "Blocked" });
  }
  const domainBlocked = await isActorDomainBlocked(env.DB, follower.id, actor.actorUri);
  if (domainBlocked.isErr()) {
    return err(domainBlocked.error);
  }
  if (domainBlocked.value) {
    return err({ kind: "DomainBlocked" });
  }
  const followerUrl = InstanceIdentity.actorUrl(identity, follower.username);
  const id = newEntityId();
  const followActivityId = `${followerUrl}/follows/${id}`;
  const inserted = await insertOutboundFollow(env.DB, {
    id,
    accountId: follower.id,
    actorUri: actor.actorUri,
    followActivityId,
  });
  if (inserted.isErr()) {
    return err(inserted.error);
  }
  const updated = await updateOutboundFollowOptions(env.DB, follower.id, actor.actorUri, options);
  if (updated.isErr()) {
    return err(updated.error);
  }
  if (!inserted.value) {
    return ok(undefined);
  }
  const enqueued = await enqueueTargetedActivity(
    env,
    follower,
    "Follow",
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      ...followActivity(followerUrl, followActivityId, actor.actorUri),
    },
    actor.inboxUri,
  );
  if (enqueued.isErr()) {
    return err({
      kind: "RepositoryError",
      message: "message" in enqueued.error ? enqueued.error.message : enqueued.error.kind,
    });
  }
  return ok(undefined);
};

/** Stop following a remote actor and send it the `Undo` of the `Follow`, when there was one. */
export const unfollowRemoteActor = async (
  env: Env,
  identity: InstanceIdentity,
  follower: LocalAccount,
  actor: RemoteActor,
): Promise<Result<void, RepositoryError>> => {
  const removed = await deleteOutboundFollow(env.DB, follower.id, actor.actorUri);
  if (removed.isErr()) {
    return err(removed.error);
  }
  if (removed.value !== undefined) {
    // Best effort: the follow is dropped whether or not the `Undo` is queued.
    await sendFollowUndo(env, identity, follower, actor, removed.value);
  }
  return ok(undefined);
};

/**
 * Send `actor` the `Undo` of `follower`'s `Follow` of it. The caller has
 * already dropped the follow, or never held it.
 */
export const sendFollowUndo = (
  env: Env,
  identity: InstanceIdentity,
  follower: LocalAccount,
  actor: RemoteActor,
  followActivityId: string,
): Promise<Result<void, EnqueueLocalActivityError>> => {
  const followerUrl = InstanceIdentity.actorUrl(identity, follower.username);
  return enqueueTargetedActivity(
    env,
    follower,
    "Undo",
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${followActivityId}/undo`,
      type: "Undo",
      actor: followerUrl,
      object: followActivity(followerUrl, followActivityId, actor.actorUri),
    },
    actor.inboxUri,
  );
};

const EmbeddedFollowSchema = z.object({
  type: z.literal("Follow"),
  actor: z.string().min(1),
  object: z.union([z.string().min(1), z.object({ id: z.string().min(1) })]),
});

const parseEmbeddedFollow = schemaResult(EmbeddedFollowSchema);

/** An `Accept` or `Reject` as received: the id it names and the object it carries. */
export type ReceivedFollowAnswer = Readonly<{
  kind: "Accept" | "Reject";
  objectId: string;
  object: unknown;
}>;

/**
 * What an `Accept` or `Reject` did. `AcceptedUnheld` is an `Accept` of a
 * `Follow` from a local account that holds no follow of the signer: the
 * signer stored a follow this server does not have, and `followActivityId`
 * is the `Follow` to undo there.
 */
export type FollowAnswerOutcome =
  | Readonly<{ kind: "Recorded" }>
  | Readonly<{ kind: "Unmatched" }>
  | Readonly<{ kind: "AcceptedUnheld"; follower: LocalAccount; followActivityId: string }>;

const followIdPrefix = (identity: InstanceIdentity, username: string): string =>
  `${InstanceIdentity.actorUrl(identity, username)}/follows/`;

/**
 * The local account an embedded `Follow` of `signer` is from, for servers
 * that do not echo our `Follow` id. The signer can only answer follows of
 * itself.
 */
const embeddedFollower = async (
  findAccountByUsername: FindLocalAccountByUsername,
  identity: InstanceIdentity,
  signer: RemoteActor,
  object: unknown,
): Promise<Result<LocalAccount | undefined, RepositoryError>> => {
  const embedded = parseEmbeddedFollow(object);
  if (embedded.isErr()) {
    return ok(undefined);
  }
  const followed =
    typeof embedded.value.object === "string" ? embedded.value.object : embedded.value.object.id;
  const username = parseLocalActorUsername(identity, embedded.value.actor);
  return followed === signer.actorUri && username ? findAccountByUsername(username) : ok(undefined);
};

/** The local account `followActivityId` is a `Follow` id of. */
const followIdOwner = async (
  findAccountByUsername: FindLocalAccountByUsername,
  identity: InstanceIdentity,
  followActivityId: string,
): Promise<Result<LocalAccount | undefined, RepositoryError>> => {
  const username = parseLocalActorUsername(identity, followActivityId);
  return username && followActivityId.startsWith(followIdPrefix(identity, username))
    ? findAccountByUsername(username)
    : ok(undefined);
};

/**
 * Record the remote actor's answer to a local account's `Follow` of it: the
 * follow whose `Follow` id the answer names, or the follow of the signer by
 * the local actor of an embedded `Follow`.
 *
 * An `Accept` that matches no follow of an account that follows the signer
 * no more is `AcceptedUnheld`. The signer stores a `Follow` after it answers
 * the request (202), and Mastodon handles an `Undo` that arrives meanwhile
 * as one that came first: it keeps the follow and sends this `Accept`.
 */
export const answerOutboundFollow = async (
  contracts: Readonly<{
    findAccountByUsername: FindLocalAccountByUsername;
    acceptOutboundFollow: AcceptOutboundFollow;
    rejectOutboundFollow: RejectOutboundFollow;
    holdsOutboundFollow: HoldsOutboundFollow;
  }>,
  identity: InstanceIdentity,
  signer: RemoteActor,
  received: ReceivedFollowAnswer,
): Promise<Result<FollowAnswerOutcome, RepositoryError>> => {
  const embedded = await embeddedFollower(
    contracts.findAccountByUsername,
    identity,
    signer,
    received.object,
  );
  if (embedded.isErr()) {
    return err(embedded.error);
  }
  const answer: OutboundFollowAnswer = {
    actorUri: signer.actorUri,
    followActivityId: received.objectId,
    accountId: embedded.value?.id,
  };
  const answered =
    received.kind === "Accept"
      ? await contracts.acceptOutboundFollow(answer)
      : await contracts.rejectOutboundFollow(answer);
  if (answered.isErr()) {
    return err(answered.error);
  }
  if (answered.value) {
    return ok({ kind: "Recorded" });
  }
  if (received.kind === "Reject") {
    return ok({ kind: "Unmatched" });
  }
  const follower =
    embedded.value === undefined
      ? await followIdOwner(contracts.findAccountByUsername, identity, received.objectId)
      : embedded;
  if (follower.isErr()) {
    return err(follower.error);
  }
  if (follower.value === undefined) {
    return ok({ kind: "Unmatched" });
  }
  const holds = await contracts.holdsOutboundFollow(follower.value.id, signer.actorUri);
  if (holds.isErr()) {
    return err(holds.error);
  }
  if (holds.value) {
    return ok({ kind: "Unmatched" });
  }
  // A server that rewrote the `Follow` id knows the follow by its actor and object.
  const prefix = followIdPrefix(identity, follower.value.username);
  return ok({
    kind: "AcceptedUnheld",
    follower: follower.value,
    followActivityId: received.objectId.startsWith(prefix)
      ? received.objectId
      : `${prefix}${newEntityId()}`,
  });
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([EmbeddedFollowSchema]);
