import { assertNever, schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { parseLocalStatusId } from "../activitypub";
import { refId, UndoneActivitySchema } from "../activitypub-wire";
import type { RepositoryError } from "../d1";
import { unfollowAccount } from "../follow-store";
import { startHomeFanOut } from "../home-fan-out";
import { deleteRemoteNotifications } from "../notification-store";
import { revokeOutboundFollow } from "../outbound-follow-store";
import { deleteRemoteFollowByActivity, undoRemoteFollow } from "../remote-actor-store";
import { deleteRemoteBlock, deleteRemoteBlockByActivity } from "../remote-block-store";
import { deleteRemoteBoostByActivity } from "../remote-boost-store";
import {
  deleteRemoteAnnounceByActivity,
  deleteRemoteFavourite,
  rememberUndone,
} from "../remote-interaction-store";
import { localAccountAt } from "./follow";
import type { InboxHandler, LocalDelivery, RemoteDelivery } from "./handler";

const parseUndoneActivity = schemaResult(UndoneActivitySchema);

/**
 * The activity a remote `Undo` takes back, as Mastodon's
 * `ActivityPub::Activity::Undo#perform` tells them apart by the embedded
 * object's `type`. `object` is the URI the undone activity names.
 */
type Undone =
  | Readonly<{ kind: "Follow" | "Like" | "Block" | "Accept"; id: string; object: string }>
  | Readonly<{ kind: "Announce"; id: string }>
  /** Named by its id only, or embedded without a `type` (`handle_reference`). */
  | Readonly<{ kind: "Reference"; id: string }>
  | Readonly<{ kind: "Unhandled" }>;

const undoneActivity = (object: string | Readonly<{ id: string }>): Undone => {
  if (typeof object === "string") {
    return { kind: "Reference", id: object };
  }
  const parsed = parseUndoneActivity(object);
  if (parsed.isErr()) {
    return { kind: "Unhandled" };
  }
  const { id, type } = parsed.value;
  const target = refId(parsed.value.object);
  switch (type) {
    case undefined:
      return { kind: "Reference", id };
    case "Announce":
      return { kind: "Announce", id };
    case "Follow":
    case "Like":
    case "Block":
    case "Accept":
      return target === undefined ? { kind: "Unhandled" } : { kind: type, id, object: target };
    default:
      return { kind: "Unhandled" };
  }
};

/** End the boost the `Announce` `announceId` made: its timeline entry, its count and its notification. */
const undoAnnounce = async (
  env: Env,
  actorUri: string,
  announceId: string,
): Promise<Result<void, RepositoryError>> => {
  const boost = await deleteRemoteBoostByActivity(env.DB, announceId, actorUri);
  if (boost.isErr()) {
    return err(boost.error);
  }
  if (boost.value) {
    await startHomeFanOut(env, {
      event: "delete",
      entryId: boost.value,
      author: { kind: "RemoteActor", actorUri },
    });
  }
  const counted = await deleteRemoteAnnounceByActivity(env.DB, actorUri, announceId);
  if (counted.isErr()) {
    return err(counted.error);
  }
  for (const statusId of counted.value) {
    await deleteRemoteNotifications(env.DB, { actorUri, kinds: ["reblog"], statusId });
  }
  return ok(undefined);
};

/**
 * A remote actor takes back an activity. As Mastodon's `delete_later!`, an
 * `Undo` of a `Like`, an `Announce` or a `Block`, or of an activity named by
 * its id only, is remembered before what it ends is deleted, so the activity
 * is dropped if it comes after (or while) the `Undo` is handled.
 */
export const receiveRemoteUndo: InboxHandler<RemoteDelivery<"Undo">> = async ({
  env,
  identity,
  signer,
  received,
}) => {
  const actorUri = signer.actorUri;
  const undone = undoneActivity(received.object);
  switch (undone.kind) {
    case "Follow": {
      const followed = await localAccountAt(env, identity, undone.object);
      // Mastodon delivers a Follow and its Undo at once, and this Undo can be
      // handled first; remembering it drops that Follow (`undoRemoteFollow`).
      return followed ? undoRemoteFollow(env.DB, actorUri, followed.id, undone.id) : ok(undefined);
    }
    case "Like": {
      const statusId = parseLocalStatusId(identity, undone.object);
      if (!statusId) {
        return ok(undefined);
      }
      const remembered = await rememberUndone(env.DB, actorUri, undone.id);
      if (remembered.isErr()) {
        return err(remembered.error);
      }
      await deleteRemoteFavourite(env.DB, actorUri, statusId);
      await deleteRemoteNotifications(env.DB, { actorUri, kinds: ["favourite"], statusId });
      return ok(undefined);
    }
    case "Block": {
      const blocked = await localAccountAt(env, identity, undone.object);
      if (!blocked) {
        return ok(undefined);
      }
      const remembered = await rememberUndone(env.DB, actorUri, undone.id);
      return remembered.isErr() ? remembered : deleteRemoteBlock(env.DB, actorUri, blocked.id);
    }
    case "Accept":
      return revokeOutboundFollow(env.DB, actorUri, undone.object);
    case "Announce": {
      const remembered = await rememberUndone(env.DB, actorUri, undone.id);
      return remembered.isErr() ? remembered : undoAnnounce(env, actorUri, undone.id);
    }
    case "Reference": {
      // Mastodon tries an Announce, a Follow and a Block by the id; a Like is
      // not looked up by its id (`try_undo_like`), only remembered.
      const remembered = await rememberUndone(env.DB, actorUri, undone.id);
      if (remembered.isErr()) {
        return remembered;
      }
      const announce = await undoAnnounce(env, actorUri, undone.id);
      if (announce.isErr()) {
        return announce;
      }
      const follow = await deleteRemoteFollowByActivity(env.DB, actorUri, undone.id);
      return follow.isErr() ? follow : deleteRemoteBlockByActivity(env.DB, actorUri, undone.id);
    }
    case "Unhandled":
      return ok(undefined);
    default:
      return assertNever(undone);
  }
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
