import { InstanceIdentity, type LocalAccount, type RemoteActor } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { blockAccount, unblockAccount } from "./block-mute-store";
import type { RepositoryError } from "./d1";
import { enqueueTargetedActivity } from "./delivery";
import { unfollowAccount } from "./follow-store";
import { unfollowRemoteActor } from "./outbound-follow";
import { findRemoteActorByUri } from "./remote-actor-store";
import { removeRemoteFollower } from "./remote-follower";

/** Whom a block names: a local account by id, or a remote actor (`accountId` null). */
export type BlockTarget = Readonly<{ accountId: string | null; actorUri: string }>;

/** Mastodon's `BlockSerializer` id when the block has no `uri` of its own. */
const blockActivity = (actorUrl: string, blockId: string, target: string) => ({
  id: `${actorUrl}#blocks/${blockId}`,
  type: "Block",
  actor: actorUrl,
  object: target,
});

/**
 * Drop the follows both ways, as `UnfollowService` and `RejectFollowService`
 * do inside Mastodon's `BlockService`: the blocker's follow or request of the
 * target (an `Undo(Follow)` to a remote one), and the target's follow or
 * request of the blocker (a `Reject(Follow)` to a remote one). Each step is
 * best effort: the block already holds, so a failed step is logged and the
 * other still runs.
 */
const severFollows = async (
  env: Env,
  identity: InstanceIdentity,
  blocker: LocalAccount,
  target: BlockTarget,
  actor: RemoteActor | undefined,
): Promise<void> => {
  const steps: ReadonlyArray<readonly [string, Result<unknown, RepositoryError>]> =
    target.accountId !== null
      ? [
          ["Unfollow", await unfollowAccount(env.DB, blocker.id, target.accountId)],
          ["RemoveFollower", await unfollowAccount(env.DB, target.accountId, blocker.id)],
        ]
      : actor
        ? [
            ["Unfollow", await unfollowRemoteActor(env, identity, blocker, actor)],
            ["RemoveFollower", await removeRemoteFollower(env, identity, blocker, actor)],
          ]
        : [];
  for (const [step, result] of steps) {
    if (result.isErr()) {
      console.error(
        JSON.stringify({
          kind: "BlockFollowNotSevered",
          step,
          blockerId: blocker.id,
          targetActorUri: target.actorUri,
          message: result.error.message,
        }),
      );
    }
  }
};

/** The cached actor of a remote target; a local target or an uncached actor has none. */
const remoteActorOf = async (
  db: D1Database,
  target: BlockTarget,
): Promise<Result<RemoteActor | undefined, RepositoryError>> =>
  target.accountId === null ? findRemoteActorByUri(db, target.actorUri) : ok(undefined);

/**
 * Block `target` as Mastodon's `BlockService`: write the block, sever the
 * follows between the two, and send a remote target the `Block`. The block
 * comes first so a failed severing step cannot leave the follows half gone
 * with no block; the caller refuses a self-block.
 */
export const blockAccountTarget = async (
  env: Env,
  identity: InstanceIdentity,
  blocker: LocalAccount,
  target: BlockTarget,
): Promise<Result<void, RepositoryError>> => {
  const actor = await remoteActorOf(env.DB, target);
  if (actor.isErr()) {
    return err(actor.error);
  }
  const blocked = await blockAccount(env.DB, blocker.id, target.accountId, target.actorUri);
  if (blocked.isErr()) {
    return err(blocked.error);
  }
  await severFollows(env, identity, blocker, target, actor.value);
  if (actor.value) {
    const actorUrl = InstanceIdentity.actorUrl(identity, blocker.username);
    // Delivery is best effort: the block already holds here.
    await enqueueTargetedActivity(
      env,
      blocker.id,
      "Block",
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        ...blockActivity(actorUrl, blocked.value, target.actorUri),
      },
      actor.value.inboxUri,
    );
  }
  return ok(undefined);
};

/** Lift a block as Mastodon's `UnblockService`: a remote target gets the `Undo(Block)`. */
export const unblockAccountTarget = async (
  env: Env,
  identity: InstanceIdentity,
  blocker: LocalAccount,
  target: BlockTarget,
): Promise<Result<void, RepositoryError>> => {
  const removed = await unblockAccount(env.DB, blocker.id, target.actorUri);
  if (removed.isErr()) {
    return err(removed.error);
  }
  const blockId = removed.value;
  if (blockId === undefined) {
    return ok(undefined);
  }
  const actor = await remoteActorOf(env.DB, target);
  if (actor.isErr()) {
    return err(actor.error);
  }
  if (actor.value) {
    const actorUrl = InstanceIdentity.actorUrl(identity, blocker.username);
    const block = blockActivity(actorUrl, blockId, target.actorUri);
    await enqueueTargetedActivity(
      env,
      blocker.id,
      "Undo",
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${block.id}/undo`,
        type: "Undo",
        actor: actorUrl,
        object: block,
      },
      actor.value.inboxUri,
    );
  }
  return ok(undefined);
};
