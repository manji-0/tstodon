import { Collection, Hostname, InstanceIdentity, type LocalAccount } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountByUsername } from "../account-store";
import { findAccountProfile } from "../account-profile-store";
import { parseLocalActorUsername } from "../activitypub";
import { refId } from "../activitypub-wire";
import { nowIso } from "../clock";
import { featureAuthorizationUri } from "../collection-documents";
import { notifyAddedToCollection } from "../collection-notify";
import { parseRows, type RepositoryError, runD1 } from "../d1";
import { z } from "zod";
import { enqueueTargetedActivity } from "../delivery";
import {
  addRemoteCollectionItem,
  fetchRemoteCollection,
  processRemoteCollection,
} from "../remote-curated-collection";
import {
  deleteRemoteCollection,
  deleteRemoteItemByUri,
  findRemoteCollectionByUri,
  insertAcceptedLocalItem,
} from "../remote-curated-collection-store";
import type { InboxHandler, RemoteDelivery } from "./handler";

type Handled = Promise<Result<boolean, RepositoryError>>;

const fetchOptions = (delivery: RemoteDelivery<"Add" | "Remove" | "FeatureRequest">) => ({
  allowHosts: delivery.allowHosts,
  blockedHosts: delivery.blockedHosts,
  fetchSigner: delivery.fetchSigner,
});

/**
 * `Add#add_collection` (to the signer's `featuredCollections`) and
 * `Add#add_collection_item` (to one of its stored collections). `false`
 * when the target is neither.
 */
export const receiveCollectionAdd = async (delivery: RemoteDelivery<"Add">): Handled => {
  const { env, identity, signer, received } = delivery;
  const target = refId(received.target);
  if (target === undefined) {
    return ok(false);
  }
  if (target === signer.profile.featuredCollectionsUri) {
    const processed = await processRemoteCollection(
      env,
      identity,
      signer,
      received.object,
      fetchOptions(delivery),
    );
    return processed.map(() => true);
  }
  const collection = await findRemoteCollectionByUri(env.DB, target);
  if (collection.isErr()) {
    return err(collection.error);
  }
  if (collection.value === undefined || collection.value.actorUri !== signer.actorUri) {
    return ok(false);
  }
  const added = await addRemoteCollectionItem(
    env,
    identity,
    collection.value,
    received.object,
    fetchOptions(delivery),
  );
  return added.map(() => true);
};

/** `Remove#remove_collection` and `Remove#remove_collection_item`. */
export const receiveCollectionRemove = async (delivery: RemoteDelivery<"Remove">): Handled => {
  const { env, signer, received, activity } = delivery;
  const target = refId(received.target);
  if (target === undefined) {
    return ok(false);
  }
  if (target === signer.profile.featuredCollectionsUri) {
    return (await deleteRemoteCollection(env.DB, signer.actorUri, activity.object)).map(() => true);
  }
  const collection = await findRemoteCollectionByUri(env.DB, target);
  if (collection.isErr()) {
    return err(collection.error);
  }
  if (collection.value === undefined || collection.value.actorUri !== signer.actorUri) {
    return ok(false);
  }
  return (await deleteRemoteItemByUri(env.DB, collection.value.id, activity.object)).map(
    () => true,
  );
};

/**
 * `Update#update_collection`: a `FeaturedCollection` on the signer's own
 * host. `false` for any other object.
 */
export const receiveCollectionUpdate = async (delivery: RemoteDelivery<"Update">): Handled => {
  const { env, identity, signer, received } = delivery;
  const object: unknown = received.object;
  const type: unknown =
    typeof object === "object" && object !== null ? Reflect.get(object, "type") : undefined;
  if (!(Array.isArray(type) ? type : [type]).includes("FeaturedCollection")) {
    return ok(false);
  }
  if (Hostname.ofUri(refId(object) ?? "") !== Hostname.ofUri(signer.actorUri)) {
    return ok(true);
  }
  const processed = await processRemoteCollection(env, identity, signer, object, {
    allowHosts: delivery.allowHosts,
    blockedHosts: delivery.blockedHosts,
    fetchSigner: delivery.fetchSigner,
  });
  return processed.map(() => true);
};

/**
 * The account a remote owner asks to feature may be: `AccountPolicy#feature?`
 * of a local account by a remote one (`featureable_by?`: discoverable, and
 * unlocked or followed by the owner), and no block either way.
 */
const mayBeFeatured = async (
  db: D1Database,
  featured: LocalAccount,
  ownerUri: string,
): Promise<Result<boolean, RepositoryError>> => {
  const profile = await findAccountProfile(db, featured.id);
  if (profile.isErr()) {
    return err(profile.error);
  }
  const read = await runD1(() =>
    db
      .prepare(
        `SELECT
         EXISTS (SELECT 1 FROM remote_follows WHERE target_account_id = ?1 AND remote_actor_uri = ?2
                 AND follow_kind = 'Accepted') AS follows,
         EXISTS (SELECT 1 FROM blocks WHERE blocker_account_id = ?1 AND target_actor_uri = ?2)
         OR EXISTS (SELECT 1 FROM remote_blocks WHERE account_id = ?1 AND actor_uri = ?2) AS blocked`,
      )
      .bind(featured.id, ownerUri)
      .all(),
  );
  if (read.isErr()) {
    return err(read.error);
  }
  const [standing] = parseRows(
    z.object({ follows: z.number(), blocked: z.number() }),
    read.value.results,
  );
  const follows = standing?.follows === 1;
  const blocked = standing?.blocked === 1;
  return ok(
    Collection.featureable({
      kind: "Local",
      ownerId: ownerUri,
      targetId: featured.id,
      targetDiscoverable: profile.value.discoverable,
      targetLocked: featured.locked,
      ownerFollowsTarget: follows,
      blockedEitherWay: blocked,
    }),
  );
};

/**
 * `ActivityPub::Activity::FeatureRequest`: a remote owner asks to feature a
 * local account in a collection of its own, stored or fetched. Allowed, the
 * account is added `accepted`, notified, and its `Accept` names its
 * authorization; refused, its `Reject` goes back. Either is signed by the
 * featured account and sent to the owner's inbox.
 */
export const receiveFeatureRequest: InboxHandler<RemoteDelivery<"FeatureRequest">> = async (
  delivery,
) => {
  const { env, identity, signer, activity, received } = delivery;
  if (Hostname.ofUri(activity.id) !== Hostname.ofUri(signer.actorUri)) {
    return ok(undefined);
  }
  const instrument = refId(received.instrument);
  const username = parseLocalActorUsername(identity, activity.object);
  if (instrument === undefined || username === undefined) {
    return ok(undefined);
  }
  const [collection, featured] = await Promise.all([
    fetchRemoteCollection(env, identity, signer, instrument, fetchOptions(delivery)),
    findAccountByUsername(env.DB, username),
  ]);
  if (collection.isErr()) {
    return err(collection.error);
  }
  if (featured.isErr()) {
    return err(featured.error);
  }
  if (collection.value === undefined || featured.value === undefined) {
    return ok(undefined);
  }
  const allowed = await mayBeFeatured(env.DB, featured.value, signer.actorUri);
  if (allowed.isErr()) {
    return err(allowed.error);
  }
  const featuredUri = InstanceIdentity.actorUrl(identity, featured.value.username);
  if (!allowed.value) {
    await enqueueTargetedActivity(
      env,
      featured.value,
      "Reject",
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        // `RejectFeatureRequestSerializer` on an item never saved: no id after the slash.
        id: `${featuredUri}#rejects/feature_requests/`,
        type: "Reject",
        actor: featuredUri,
        to: signer.actorUri,
        object: activity.id,
      },
      signer.inboxUri,
    );
    return ok(undefined);
  }
  const itemId = await insertAcceptedLocalItem(
    env.DB,
    collection.value.id,
    featured.value.id,
    activity.id,
    nowIso(),
  );
  if (itemId.isErr()) {
    return err(itemId.error);
  }
  if (itemId.value === undefined) {
    return ok(undefined);
  }
  await notifyAddedToCollection(env, collection.value, itemId.value, featured.value.id);
  await enqueueTargetedActivity(
    env,
    featured.value,
    "Accept",
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${featuredUri}#accepts/feature_requests/${itemId.value}`,
      type: "Accept",
      actor: featuredUri,
      to: signer.actorUri,
      object: activity.id,
      result: featureAuthorizationUri(identity, featured.value.id, itemId.value),
    },
    signer.inboxUri,
  );
  return ok(undefined);
};
