import { OutboxBackfill, type RemoteActor } from "@tstodon/domain";
import { err, ok } from "neverthrow";
import { isHashtagObject, refId } from "../activitypub-wire";
import { addRemoteActorPin, removeRemoteActorPin } from "../remote-actor-pin-store";
import { persistRemoteObject } from "../remote-status-persist";
import type { InboxHandler, RemoteDelivery } from "./handler";

/**
 * Whether the activity pins or unpins a note: its `target` is the signer's
 * own `featured` collection, as Mastodon's `Add` and `Remove` check, and its
 * object is not a `Hashtag`. Mastodon sends a featured hashtag to the same
 * collection; tstodon keeps no remote featured hashtags yet (INT-14), so
 * that one is accepted and dropped, without a fetch. Any other collection is
 * ignored.
 */
const pinsNote = (signer: RemoteActor, target: unknown, object: unknown): boolean =>
  signer.featuredUri !== undefined &&
  refId(target) === signer.featuredUri &&
  !isHashtagObject(object);

/**
 * A remote actor pinned a note (Mastodon's `Add#add_featured`): the note is
 * its own and on its host, fetched when it is not cached, and becomes its
 * first pin. One fetch at most.
 */
export const receiveRemoteAdd: InboxHandler<RemoteDelivery<"Add">> = async ({
  env,
  identity,
  signer,
  activity,
  received,
  allowHosts,
  blockedHosts,
  fetchSigner,
}) => {
  if (
    !pinsNote(signer, received.target, received.object) ||
    !OutboxBackfill.onActorHost(activity.object, signer.actorUri)
  ) {
    return ok(undefined);
  }
  // By its URI, so a note this server does not hold is read from its own address.
  const stored = await persistRemoteObject(env, identity, signer, activity.object, {
    allowHosts,
    blockedHosts,
    fetchSigner,
    idClock: "Published",
  });
  if (stored.isErr()) {
    return err(stored.error);
  }
  if (stored.value?.actorUri !== signer.actorUri) {
    return ok(undefined);
  }
  return addRemoteActorPin(env.DB, signer.actorUri, stored.value.id);
};

/** A remote actor unpinned a note (Mastodon's `Remove#remove_featured`). */
export const receiveRemoteRemove: InboxHandler<RemoteDelivery<"Remove">> = async ({
  env,
  signer,
  activity,
  received,
}) =>
  pinsNote(signer, received.target, received.object)
    ? removeRemoteActorPin(env.DB, signer.actorUri, activity.object)
    : ok(undefined);
