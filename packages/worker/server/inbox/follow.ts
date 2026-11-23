import type { ApActivityDocumentOf } from "@tstodon/api/activitypub";
import {
  InstanceIdentity,
  type LocalAccount,
  type RecordInboxFollow,
  RemoteActor,
} from "@tstodon/domain";
import { err, ok } from "neverthrow";
import { findAccountByUsername } from "../account-store";
import { parseLocalActorUsername } from "../activitypub";
import { findBlock } from "../block-mute-store";
import { enqueueTargetedActivity } from "../delivery";
import { isActorDomainBlocked } from "../domain-block-store";
import { followAccount } from "../follow-store";
import { notifyFromRemote, notifyNewFollow } from "../notify";
import { isRemoteActorSilenced } from "../remote-actor-moderation-store";
import { findRemoteFollow, upsertRemoteFollow } from "../remote-actor-store";
import { sendFollowReject } from "../remote-follower";
import type { ActivityOf, InboxHandler, LocalDelivery, RemoteDelivery } from "./handler";

/** The `Accept` an unlocked account sends back for a remote actor's `Follow`. */
const followAcceptActivity = (
  identity: InstanceIdentity,
  target: LocalAccount,
  follower: RemoteActor,
  follow: ActivityOf<"Follow">,
): ApActivityDocumentOf<"Accept"> => {
  const acceptActor = InstanceIdentity.actorUrl(identity, target.username);
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${acceptActor}/activities/accept-${follow.id}`,
    type: "Accept",
    actor: acceptActor,
    object: { id: follow.id, type: "Follow", actor: follower.actorUri, object: follow.object },
  };
};

/** The local account an actor URI names, if it exists. */
export const localAccountAt = async (
  env: Env,
  identity: InstanceIdentity,
  object: string,
): Promise<LocalAccount | undefined> => {
  const username = parseLocalActorUsername(identity, object);
  const target = username ? await findAccountByUsername(env.DB, username) : undefined;
  return target?.isOk() ? target.value : undefined;
};

/** What follows from recording a remote actor's `Follow`. */
export type InboxFollowOutcome = Readonly<{
  /** The notification the followed account gets, if any. */
  notify: "follow" | "follow_request" | undefined;
  /** An unlocked account accepts at once. */
  sendAccept: boolean;
}>;

/** What the actor already holds of the target when its `Follow` arrives. */
export type HeldFollow = "None" | "Requested" | "Following";

/**
 * Record a remote actor's `Follow` of `target`, as Mastodon's
 * `ActivityPub::Activity::Follow`. A first Follow waits for approval when the
 * target is locked or the follower silenced, and notifies. A Follow of a
 * request already held keeps it a request, with the new activity id
 * (`existing_follow_request`); one of a follow already held is accepted again
 * (`existing_follow`), locked or silenced. Neither notifies. Nothing is
 * notified when the follow could not be recorded. A Follow whose `Undo` was
 * handled first is dropped: no notification and no `Accept`.
 */
export const recordInboxFollow = async (
  record: RecordInboxFollow,
  target: LocalAccount,
  follower: Readonly<{ actorUri: string; silenced: boolean; held: HeldFollow }>,
  followActivityId: string,
): Promise<InboxFollowOutcome> => {
  const requiresApproval =
    follower.held === "Requested" ||
    (follower.held === "None" && (target.locked || follower.silenced));
  const followed = await record({
    actorUri: follower.actorUri,
    targetAccountId: target.id,
    requiresApproval,
    followActivityId,
  });
  const undoneFirst = followed.isOk() && followed.value === "UndoneFirst";
  const firstFollow = followed.isOk() && !undoneFirst && follower.held === "None";
  return {
    notify: firstFollow ? (requiresApproval ? "follow_request" : "follow") : undefined,
    sendAccept: !requiresApproval && !undoneFirst,
  };
};

export const receiveRemoteFollow: InboxHandler<RemoteDelivery<"Follow">> = async ({
  env,
  identity,
  signer,
  activity,
}) => {
  const target = await localAccountAt(env, identity, activity.object);
  if (!target) {
    return ok(undefined);
  }
  const [blocked, domainBlocked, existing, silenced] = await Promise.all([
    findBlock(env.DB, target.id, signer.actorUri),
    isActorDomainBlocked(env.DB, target.id, signer.actorUri),
    findRemoteFollow(env.DB, target.id, signer.actorUri),
    isRemoteActorSilenced(env.DB, signer.actorUri),
  ]);
  // Mastodon's `ActivityPub::Activity::Follow` rejects a follower that the
  // target blocks, by account or by domain.
  const refused = blocked.isErr() || blocked.value ? blocked : domainBlocked;
  if (refused.isErr()) {
    return err(refused.error);
  }
  if (refused.value) {
    await sendFollowReject(env, identity, target, signer, activity.id);
    return ok(undefined);
  }
  if (silenced.isErr()) {
    return err(silenced.error);
  }
  if (existing.isErr()) {
    return err(existing.error);
  }
  const held: HeldFollow =
    existing.value === undefined
      ? "None"
      : existing.value.requestKind === "Fulfilled"
        ? "Following"
        : "Requested";
  const outcome = await recordInboxFollow(
    (follow) => upsertRemoteFollow(env.DB, follow),
    target,
    { actorUri: signer.actorUri, silenced: silenced.value, held },
    activity.id,
  );
  if (outcome.notify) {
    await notifyFromRemote(env, {
      accountId: target.id,
      actorUri: signer.actorUri,
      kind: outcome.notify,
    });
  }
  if (outcome.sendAccept) {
    await enqueueTargetedActivity(
      env,
      target,
      "Accept",
      followAcceptActivity(identity, target, signer, activity),
      RemoteActor.deliveryInbox(signer),
    );
  }
  return ok(undefined);
};

export const receiveLocalFollow: InboxHandler<LocalDelivery<"Follow">> = async ({
  env,
  identity,
  signer,
  activity,
}) => {
  const target = await localAccountAt(env, identity, activity.object);
  if (!target) {
    return ok(undefined);
  }
  const blocked = await findBlock(env.DB, target.id, signer.id);
  if (blocked.isErr()) {
    return err(blocked.error);
  }
  if (blocked.value) {
    return ok(undefined);
  }
  const followed = await followAccount(env.DB, signer.id, target.id, target.locked);
  if (followed.isOk()) {
    await notifyNewFollow(env, signer.id, target.id, followed.value);
  }
  return ok(undefined);
};
