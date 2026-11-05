import { err, ok } from "neverthrow";
import { unfollowRemoteActor } from "../outbound-follow";
import { removeRemoteFollower } from "../remote-follower";
import { localAccountAt } from "./follow";
import type { InboxHandler, RemoteDelivery } from "./handler";

/**
 * A remote actor blocks a local account: as Mastodon's
 * `ActivityPub::Activity::Block`, the follows between the two end both ways,
 * with an `Undo(Follow)` and a `Reject(Follow)` back to the actor. The block
 * itself is not recorded here.
 */
export const receiveRemoteBlock: InboxHandler<RemoteDelivery<"Block">> = async ({
  env,
  identity,
  signer,
  activity,
}) => {
  const target = await localAccountAt(env, identity, activity.object);
  if (!target) {
    return ok(undefined);
  }
  const unfollowed = await unfollowRemoteActor(env, identity, target, signer);
  if (unfollowed.isErr()) {
    return err(unfollowed.error);
  }
  return (await removeRemoteFollower(env, identity, target, signer)).map(() => undefined);
};
