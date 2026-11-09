import type { ApFollowJSON } from "@tstodon/api/activitypub";
import {
  type AcceptOutboundFollow,
  type FindLocalAccountByUsername,
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
import { enqueueTargetedActivity } from "./delivery";
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
    follower.id,
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
    await sendFollowUndo(env, identity, follower, actor, removed.value);
  }
  return ok(undefined);
};

/**
 * Send `actor` the `Undo` of `follower`'s `Follow` of it. Delivery is best
 * effort: the caller has already dropped the follow.
 */
export const sendFollowUndo = async (
  env: Env,
  identity: InstanceIdentity,
  follower: LocalAccount,
  actor: RemoteActor,
  followActivityId: string,
): Promise<void> => {
  const followerUrl = InstanceIdentity.actorUrl(identity, follower.username);
  await enqueueTargetedActivity(
    env,
    follower.id,
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
 * Which follow an `Accept` or `Reject` signed by `signer` answers: the one
 * whose `Follow` id is `objectId`. The signer can only answer follows of
 * itself. An embedded `Follow` of the signer by a local actor also names that
 * account's follow, for servers that do not echo our `Follow` id.
 */
const outboundFollowAnswer = async (
  findAccountByUsername: FindLocalAccountByUsername,
  identity: InstanceIdentity,
  signer: RemoteActor,
  received: ReceivedFollowAnswer,
): Promise<Result<OutboundFollowAnswer, RepositoryError>> => {
  const answer = {
    actorUri: signer.actorUri,
    followActivityId: received.objectId,
    accountId: undefined,
  };
  const embedded = parseEmbeddedFollow(received.object);
  if (embedded.isErr()) {
    return ok(answer);
  }
  const followed =
    typeof embedded.value.object === "string" ? embedded.value.object : embedded.value.object.id;
  const username = parseLocalActorUsername(identity, embedded.value.actor);
  if (followed !== signer.actorUri || !username) {
    return ok(answer);
  }
  const follower = await findAccountByUsername(username);
  if (follower.isErr()) {
    return err(follower.error);
  }
  return ok({ ...answer, accountId: follower.value?.id });
};

/** Record the remote actor's answer to a local account's `Follow` of it. */
export const answerOutboundFollow = async (
  contracts: Readonly<{
    findAccountByUsername: FindLocalAccountByUsername;
    acceptOutboundFollow: AcceptOutboundFollow;
    rejectOutboundFollow: RejectOutboundFollow;
  }>,
  identity: InstanceIdentity,
  signer: RemoteActor,
  received: ReceivedFollowAnswer,
): Promise<Result<void, RepositoryError>> => {
  const answer = await outboundFollowAnswer(
    contracts.findAccountByUsername,
    identity,
    signer,
    received,
  );
  if (answer.isErr()) {
    return err(answer.error);
  }
  const answered =
    received.kind === "Accept"
      ? await contracts.acceptOutboundFollow(answer.value)
      : await contracts.rejectOutboundFollow(answer.value);
  return answered.map(() => undefined);
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([EmbeddedFollowSchema]);
