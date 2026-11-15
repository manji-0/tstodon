import { OutboxBackfill, type RemoteActor } from "@tstodon/domain";
import { err, ok } from "neverthrow";
import { isHashtagObject, refId } from "../activitypub-wire";
import { addRemoteActorPin, removeRemoteActorPin } from "../remote-actor-pin-store";
import {
  addRemoteFeaturedTag,
  type FeaturedHashtag,
  featuredHashtag,
  removeRemoteFeaturedTag,
} from "../remote-featured-tag-store";
import { persistRemoteObject } from "../remote-status-persist";
import type { InboxHandler, RemoteDelivery } from "./handler";

/**
 * What an `Add` or `Remove` changes, as Mastodon's handlers read it: only
 * one whose `target` is the signer's own `featured` collection counts, and
 * there a `Hashtag` object is a featured hashtag (`add_featured_tags`) and
 * any other a pinned note (`add_featured`). Any other collection is ignored.
 */
const featuredChange = (
  signer: RemoteActor,
  target: unknown,
  object: unknown,
):
  | Readonly<{ kind: "Note" }>
  | Readonly<{ kind: "Hashtag"; tag: FeaturedHashtag | undefined }>
  | undefined => {
  if (signer.featuredUri === undefined || refId(target) !== signer.featuredUri) {
    return undefined;
  }
  return isHashtagObject(object)
    ? { kind: "Hashtag", tag: featuredHashtag(object) }
    : { kind: "Note" };
};

/**
 * A remote actor featured a hashtag (Mastodon's `Add#add_featured_tags`),
 * kept last of at most ten, or pinned a note (`Add#add_featured`): the note
 * is its own and on its host, fetched when it is not cached, and becomes its
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
  const change = featuredChange(signer, received.target, received.object);
  if (change?.kind === "Hashtag") {
    return change.tag ? addRemoteFeaturedTag(env.DB, signer.actorUri, change.tag) : ok(undefined);
  }
  if (change === undefined || !OutboxBackfill.onActorHost(activity.object, signer.actorUri)) {
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

/**
 * A remote actor unpinned a note or stopped featuring a hashtag (Mastodon's
 * `Remove#remove_featured` and `remove_featured_tags`).
 */
export const receiveRemoteRemove: InboxHandler<RemoteDelivery<"Remove">> = async ({
  env,
  signer,
  activity,
  received,
}) => {
  const change = featuredChange(signer, received.target, received.object);
  if (change?.kind === "Hashtag") {
    return change.tag
      ? removeRemoteFeaturedTag(env.DB, signer.actorUri, change.tag.tagName)
      : ok(undefined);
  }
  return change === undefined
    ? ok(undefined)
    : removeRemoteActorPin(env.DB, signer.actorUri, activity.object);
};
