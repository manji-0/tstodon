import { ACTIVITY_STREAMS, type ApActivityDocumentJSON } from "@tstodon/api/activitypub";
import {
  type Collection,
  type CollectionItem,
  InstanceIdentity,
  type LocalAccount,
} from "@tstodon/domain";
import { findAccountsByIds } from "./account-store";
import {
  type ActorUriOf,
  collectionItemUri,
  collectionUri,
  curatedCollectionObject,
  featureAuthorizationContext,
  featureAuthorizationUri,
  featuredCollectionContext,
  featuredCollectionsUri,
  featuredItemContext,
  featuredItemObject,
} from "./collection-documents";
import { err, ok, type Result } from "neverthrow";
import { enqueueLocalActivity, enqueueTargetedActivity } from "./delivery";
import { deliveredActivity } from "./own-activity-signature";
import { RemoteAccountId } from "./remote-account-id";
import { findRemoteActorByUri } from "./remote-actor-store";
import { parseInstanceIdentity } from "./runtime-config";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

/** What happened to a local collection that its owner's reach hears of. */
export type CollectionEvent =
  /** `CreateCollectionService`: `Add` to `featuredCollections`. */
  | Readonly<{ kind: "Created"; collection: Collection }>
  /** `UpdateCollectionService`, when a federated field changed. */
  | Readonly<{ kind: "Updated"; collection: Collection }>
  /** `DeleteCollectionService`: `Remove` from `featuredCollections`. */
  | Readonly<{ kind: "Deleted"; collection: Collection }>
  /** `AddAccountToCollectionService` for a local account. */
  | Readonly<{ kind: "ItemAdded"; collection: Collection; item: CollectionItem }>
  /** `DeleteCollectionItemService` of a local collection. */
  | Readonly<{ kind: "ItemRemoved"; collection: Collection; item: CollectionItem }>
  /** `FeatureRequestWorker`: ask a remote account's server to feature it. */
  | Readonly<{ kind: "FeatureRequested"; collection: Collection; item: CollectionItem }>
  /** `RevokeCollectionItemService`: the featured account withdraws its consent. */
  | Readonly<{
      kind: "ItemRevoked";
      collection: Collection;
      item: CollectionItem;
      featured: LocalAccount;
    }>;

/** `UpdateFeaturedCollectionSerializer#id`: the collection's URI and its `updated_at` in seconds. */
const updateId = (identity: InstanceIdentity, collection: Collection): string =>
  `${collectionUri(identity, collection)}#updates/${Math.floor(Date.parse(collection.updatedAt) / 1000)}`;

/** The activity Mastodon's serializer makes of `event`, as its owner sends it. */
export const collectionActivity = (
  identity: InstanceIdentity,
  owner: LocalAccount,
  event: CollectionEvent,
  actorUriOf: ActorUriOf,
): ApActivityDocumentJSON | undefined => {
  const actor = InstanceIdentity.actorUrl(identity, owner.username);
  const { collection } = event;
  switch (event.kind) {
    case "Created":
      return {
        "@context": featuredCollectionContext,
        type: "Add",
        actor,
        target: featuredCollectionsUri(identity, collection.accountId),
        object: curatedCollectionObject(identity, collection, actorUriOf),
      };
    case "Updated":
      return {
        "@context": featuredCollectionContext,
        id: updateId(identity, collection),
        type: "Update",
        actor,
        to: [PUBLIC],
        object: curatedCollectionObject(identity, collection, actorUriOf),
      };
    case "Deleted":
      return {
        "@context": ACTIVITY_STREAMS,
        type: "Remove",
        actor,
        target: featuredCollectionsUri(identity, collection.accountId),
        object: collectionUri(identity, collection),
      };
    case "ItemAdded": {
      const object = featuredItemObject(identity, collection, event.item, actorUriOf);
      return (
        object && {
          "@context": featuredItemContext,
          type: "Add",
          actor,
          target: collectionUri(identity, collection),
          object,
        }
      );
    }
    case "ItemRemoved":
      return {
        "@context": ACTIVITY_STREAMS,
        type: "Remove",
        actor,
        target: collectionUri(identity, collection),
        object: collectionItemUri(identity, collection, event.item.id),
      };
    case "FeatureRequested": {
      const featured = RemoteAccountId.decode(event.item.accountId);
      return featured.isOk() && event.item.activityUri !== undefined
        ? {
            "@context": [ACTIVITY_STREAMS, { FeatureRequest: FEATURE_REQUEST_TYPE }],
            id: event.item.activityUri,
            type: "FeatureRequest",
            object: featured.value,
            instrument: collectionUri(identity, collection),
          }
        : undefined;
    }
    case "ItemRevoked": {
      const featured = InstanceIdentity.actorUrl(identity, event.featured.username);
      const authorization = featureAuthorizationUri(identity, event.item.accountId, event.item.id);
      return {
        "@context": featureAuthorizationContext,
        id: `${authorization}#delete`,
        type: "Delete",
        actor: featured,
        to: [PUBLIC],
        object: {
          id: authorization,
          type: "FeatureAuthorization",
          interactingObject: collectionUri(identity, collection),
          interactionTarget: featured,
        },
      };
    }
    default:
      return event satisfies never;
  }
};

const FEATURE_REQUEST_TYPE = "https://w3id.org/fep/7aa9#FeatureRequest";

/**
 * A `FeatureRequest` goes to the featured account's inbox alone; any other
 * activity to the owner's reach.
 */
const enqueueCollectionActivity = async (
  env: Env,
  owner: LocalAccount,
  event: CollectionEvent,
  activity: ApActivityDocumentJSON,
): Promise<Result<void, unknown>> => {
  switch (event.kind) {
    case "FeatureRequested": {
      const actorUri = RemoteAccountId.decode(event.item.accountId);
      const actor = actorUri.isOk()
        ? await findRemoteActorByUri(env.DB, actorUri.value)
        : ok(undefined);
      if (actor.isErr() || actor.value === undefined) {
        return err(undefined);
      }
      return enqueueTargetedActivity(env, owner, activity.type, activity, actor.value.inboxUri);
    }
    case "ItemRevoked":
      return enqueueLocalActivity(
        env,
        owner,
        activity.type,
        await deliveredActivity(env, event.featured, activity),
      );
    default:
      return enqueueLocalActivity(env, owner, activity.type, activity);
  }
};

/**
 * Queue `event`'s activity from the collection's owner to its reach
 * (`CollectionRawDistributionWorker`). A revoke's `Delete` is signed by the
 * featured account, as `RevokeCollectionItemService` signs it, and sent by
 * the owner. A failure is logged: the REST answer stands, as Mastodon's
 * workers run after it.
 */
export const federateCollection = async (
  env: Env,
  owner: LocalAccount,
  event: CollectionEvent,
): Promise<void> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return;
  }
  const accounts = await findAccountsByIds(env.DB, [
    event.collection.accountId,
    ...event.collection.items.map((item) => item.accountId),
    ...("item" in event ? [event.item.accountId] : []),
  ]);
  const actorUriOf: ActorUriOf = (accountId) => {
    const account = accounts.isOk() ? accounts.value.get(accountId) : undefined;
    return account && InstanceIdentity.actorUrl(identity.value, account.username);
  };
  const activity = collectionActivity(identity.value, owner, event, actorUriOf);
  if (activity === undefined) {
    return;
  }
  const enqueued = await enqueueCollectionActivity(env, owner, event, activity);
  if (enqueued.isErr()) {
    console.error(
      JSON.stringify({
        kind: "CollectionActivityNotFederated",
        event: event.kind,
        collectionId: event.collection.id,
      }),
    );
  }
};
