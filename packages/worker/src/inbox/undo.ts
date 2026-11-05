import { schemaResult } from "@tstodon/core";
import type { InstanceIdentity } from "@tstodon/domain";
import { err, ok } from "neverthrow";
import { parseLocalStatusId } from "../activitypub";
import { NestedActivityObjectSchema } from "../activitypub-wire";
import { unfollowAccount } from "../follow-store";
import { enqueueHomeFanOut } from "../home-fan-out";
import { deleteRemoteNotifications } from "../notification-store";
import { deleteRemoteFollow } from "../remote-actor-store";
import { deleteRemoteBoostByActivity } from "../remote-boost-store";
import { deleteRemoteAnnounce, deleteRemoteFavourite } from "../remote-interaction-store";
import { localAccountAt } from "./follow";
import type { ActivityOf, InboxHandler, LocalDelivery, RemoteDelivery } from "./handler";

const parseNestedActivityObject = schemaResult(NestedActivityObjectSchema);

const objectUriOf = (value: string | Readonly<{ id: string }>): string =>
  typeof value === "string" ? value : value.id;

/** What a remote actor's `Undo` may take back on this server. */
type RemoteUndoTargets = Readonly<{
  /** Names the local account whose follow by the signer ends. */
  followedUri: string;
  favouritedStatusId: string | undefined;
  boostedStatusId: string | undefined;
  /** Keys the signer's boost row, whether the Undo embeds the Announce or names it. */
  announceUri: string;
}>;

const remoteUndoTargets = (
  identity: InstanceIdentity,
  undo: ActivityOf<"Undo">,
  object: string | Readonly<{ id: string }>,
): RemoteUndoTargets => {
  const nested = parseNestedActivityObject(object);
  const undone = nested.isOk()
    ? { type: nested.value.type, objectUri: objectUriOf(nested.value.object) }
    : undefined;
  const statusId =
    undone && (undone.type === "Like" || undone.type === "Announce")
      ? parseLocalStatusId(identity, undone.objectUri)
      : undefined;
  return {
    followedUri: undone?.type === "Follow" ? undone.objectUri : undo.object,
    favouritedStatusId: undone?.type === "Like" ? statusId : undefined,
    boostedStatusId: undone?.type === "Announce" ? statusId : undefined,
    announceUri: objectUriOf(object),
  };
};

export const receiveRemoteUndo: InboxHandler<RemoteDelivery<"Undo">> = async ({
  env,
  identity,
  signer,
  activity,
  received,
}) => {
  const targets = remoteUndoTargets(identity, activity, received.object);
  const actorUri = signer.actorUri;
  const followed = await localAccountAt(env, identity, targets.followedUri);
  if (followed) {
    await deleteRemoteFollow(env.DB, actorUri, followed.id);
    await deleteRemoteNotifications(env.DB, {
      actorUri,
      kinds: ["follow", "follow_request"],
      accountId: followed.id,
    });
  }
  if (targets.favouritedStatusId) {
    const statusId = targets.favouritedStatusId;
    await deleteRemoteFavourite(env.DB, actorUri, statusId);
    await deleteRemoteNotifications(env.DB, { actorUri, kinds: ["favourite"], statusId });
  }
  const undone = await deleteRemoteBoostByActivity(env.DB, targets.announceUri, actorUri);
  if (undone.isErr()) {
    return err(undone.error);
  }
  if (undone.value) {
    await enqueueHomeFanOut(env, {
      event: "delete",
      entryId: undone.value,
      author: { kind: "RemoteActor", actorUri },
    });
  }
  if (targets.boostedStatusId) {
    const statusId = targets.boostedStatusId;
    await deleteRemoteAnnounce(env.DB, actorUri, statusId);
    await deleteRemoteNotifications(env.DB, { actorUri, kinds: ["reblog"], statusId });
  }
  return ok(undefined);
};

/** A local account's `Undo` names the account it stops following. */
export const receiveLocalUndo: InboxHandler<LocalDelivery<"Undo">> = async ({
  env,
  identity,
  signer,
  activity,
}) => {
  const target = await localAccountAt(env, identity, activity.object);
  if (target) {
    await unfollowAccount(env.DB, signer.id, target.id);
  }
  return ok(undefined);
};
