import {
  type HasRemoteFollow,
  InstanceIdentity,
  type LocalAccount,
  type RecordInboxFollow,
  RemoteActor,
} from "@tstodon/domain";
import { ok } from "neverthrow";
import { findAccountByUsername } from "../account-store";
import { parseLocalActorUsername } from "../activitypub";
import { enqueueTargetedActivity } from "../delivery";
import { followAccount } from "../follow-store";
import { notifyAccount, notifyFromRemote } from "../notify";
import { findRemoteFollow, upsertRemoteFollow } from "../remote-actor-store";
import type { ActivityOf, InboxHandler, LocalDelivery, RemoteDelivery } from "./handler";

/** The `Accept` an unlocked account sends back for a remote actor's `Follow`. */
const followAcceptActivity = (
  identity: InstanceIdentity,
  target: LocalAccount,
  follower: RemoteActor,
  follow: ActivityOf<"Follow">,
): Record<string, unknown> => {
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

/**
 * Record a remote actor's `Follow` of `target`. A redelivered Follow keeps
 * its row and must not notify again; nothing is notified when the follow
 * could not be recorded.
 */
export const recordInboxFollow = async (
  contracts: Readonly<{ hasRemoteFollow: HasRemoteFollow; recordInboxFollow: RecordInboxFollow }>,
  target: LocalAccount,
  actorUri: string,
  followActivityId: string,
): Promise<InboxFollowOutcome> => {
  const existing = await contracts.hasRemoteFollow(target.id, actorUri);
  const followed = await contracts.recordInboxFollow({
    actorUri,
    targetAccountId: target.id,
    targetLocked: target.locked,
    followActivityId,
  });
  const firstFollow = followed.isOk() && existing.isOk() && !existing.value;
  return {
    notify: firstFollow ? (target.locked ? "follow_request" : "follow") : undefined,
    sendAccept: !target.locked,
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
  const outcome = await recordInboxFollow(
    {
      hasRemoteFollow: async (targetAccountId, actorUri) =>
        (await findRemoteFollow(env.DB, targetAccountId, actorUri)).map(
          (follow) => follow !== undefined,
        ),
      recordInboxFollow: (follow) => upsertRemoteFollow(env.DB, follow),
    },
    target,
    signer.actorUri,
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
      target.id,
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
  const followed = await followAccount(env.DB, signer.id, target.id, target.locked);
  if (
    followed.isOk() &&
    followed.value.kind === "LocalFollower" &&
    followed.value.follow.kind !== "None"
  ) {
    await notifyAccount(env, {
      accountId: target.id,
      fromAccountId: signer.id,
      kind: followed.value.follow.kind === "Pending" ? "follow_request" : "follow",
    });
  }
  return ok(undefined);
};
