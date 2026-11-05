import { InstanceIdentity, type LocalAccount, RemoteActor } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { enqueueTargetedActivity } from "./delivery";
import { deleteRemoteFollow, findRemoteFollow } from "./remote-actor-store";

/**
 * Send `actor` the `Reject` of its `Follow` of `account`. Delivery is best
 * effort: the caller has already dropped the follow.
 */
export const sendFollowReject = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  actor: RemoteActor,
  followActivityId: string,
): Promise<void> => {
  const actorUrl = InstanceIdentity.actorUrl(identity, account.username);
  await enqueueTargetedActivity(
    env,
    account.id,
    "Reject",
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actorUrl}/activities/reject-${followActivityId}`,
      type: "Reject",
      actor: actorUrl,
      object: { id: followActivityId, type: "Follow", actor: actor.actorUri, object: actorUrl },
    },
    RemoteActor.deliveryInbox(actor),
  );
};

/**
 * Drop `actor`'s follow of `account`, accepted or still requested, and send
 * it the `Reject`. Answers whether there was a follow to drop.
 */
export const removeRemoteFollower = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  actor: RemoteActor,
): Promise<Result<boolean, RepositoryError>> => {
  const existing = await findRemoteFollow(env.DB, account.id, actor.actorUri);
  if (existing.isErr()) {
    return err(existing.error);
  }
  if (!existing.value) {
    return ok(false);
  }
  const dropped = await deleteRemoteFollow(env.DB, actor.actorUri, account.id);
  if (dropped.isErr()) {
    return err(dropped.error);
  }
  await sendFollowReject(
    env,
    identity,
    account,
    actor,
    existing.value.followActivityId ?? actor.actorUri,
  );
  return ok(true);
};
