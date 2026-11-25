import type { ApiCollectionJSON, CollectionAccountItem } from "@tstodon/api";
import {
  ACTIVITY_STREAMS,
  type ApContextJSON,
  type ApCuratedCollectionJSON,
  type ApFeatureAuthorizationDocumentJSON,
  type ApFeaturedItemJSON,
} from "@tstodon/api/activitypub";
import {
  Collection,
  type CollectionItem,
  InstanceIdentity,
  type LocalAccount,
  type RemoteCollection,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import {
  blockedAccountIds,
  findCollectionOfItem,
  findCollections,
  findItemCollectionIds,
} from "./collection-store";
import type { RepositoryError } from "./d1";
import { RemoteAccountId } from "./remote-account-id";
import {
  findRemoteCollectionOfItem,
  findRemoteCollections,
  findRemoteItemCollectionIds,
} from "./remote-curated-collection-store";
import { sanitizeRemoteHtml } from "./sanitize-html";
import { hashtagObject } from "./activitypub";
import { tagUrl } from "./tag-documents";

const origin = (identity: InstanceIdentity): string => identity.publicOrigin.replace(/\/$/, "");

/** A collection's ActivityPub id (`ap_account_collection_url`). */
export const collectionUri = (identity: InstanceIdentity, collection: Collection): string =>
  `${origin(identity)}/ap/users/${collection.accountId}/collections/${collection.id}`;

/** A collection's page (`collection_url`). */
export const collectionUrl = (identity: InstanceIdentity, collection: Collection): string =>
  `${origin(identity)}/collections/${collection.id}`;

/** Who reads a collection: the signed-in account and the accounts it blocks. */
export type CollectionViewer = Readonly<{
  id: string | undefined;
  blocking: ReadonlySet<string>;
}>;

export const ANONYMOUS_VIEWER: CollectionViewer = { id: undefined, blocking: new Set() };

/** `REST::CollectionItemSerializer`: `account_id` on a pending or accepted item only. */
const mastodonCollectionItem = (item: CollectionItem): CollectionAccountItem => ({
  id: item.id,
  state: item.state,
  created_at: item.createdAt,
  ...(Collection.live(item) ? { account_id: item.accountId } : {}),
});

/**
 * `REST::CollectionSerializer` for `viewer`: the items it may see
 * (`Collection#items_for`), and `item_count` counting those.
 */
export const mastodonCollection = (
  identity: InstanceIdentity,
  collection: Collection | RemoteCollection,
  viewer: CollectionViewer,
): ApiCollectionJSON => {
  const items = Collection.itemsFor(collection, viewer.id, viewer.blocking);
  const local = collection.kind === "LocalCollection";
  return {
    id: collection.id,
    uri: local ? collectionUri(identity, collection) : collection.uri,
    name: collection.name,
    // A remote collection's summary is its HTML, sanitized (`MASTODON_STRICT`).
    description: local ? collection.description : sanitizeRemoteHtml(collection.descriptionHtml),
    language: collection.language,
    account_id: collection.accountId,
    local,
    sensitive: collection.sensitive,
    discoverable: collection.discoverable,
    url: local ? collectionUrl(identity, collection) : collection.url,
    item_count: items.length,
    created_at: collection.createdAt,
    updated_at: collection.updatedAt,
    tag:
      collection.tagName === null
        ? null
        : { name: collection.tagName, url: tagUrl(identity, collection.tagName) },
    items: items.map(mastodonCollectionItem),
  };
};

/** {@link CollectionViewer} for `viewerId` over the accounts `collections` feature. */
export const collectionViewer = async (
  db: D1Database,
  viewerId: string | undefined,
  collections: ReadonlyArray<Collection | RemoteCollection>,
): Promise<Result<CollectionViewer, RepositoryError>> =>
  viewerId === undefined
    ? ok(ANONYMOUS_VIEWER)
    : (
        await blockedAccountIds(
          db,
          viewerId,
          collections.flatMap((collection) => collection.items.map((item) => item.accountId)),
        )
      ).map((blocking) => ({ id: viewerId, blocking }));

/** What a collection notification points at: the collection, or the item added. */
export type CollectionTarget = Readonly<{
  collectionId: string | null;
  collectionItemId: string | null;
}>;

/**
 * `Notification#target_collection` for each target, rendered for the
 * recipient: `null` once the collection, or the item added, is gone.
 */
export const notificationCollections = async (
  env: Env,
  identity: InstanceIdentity,
  viewerId: string,
  targets: ReadonlyArray<CollectionTarget>,
): Promise<Result<(target: CollectionTarget) => ApiCollectionJSON | null, RepositoryError>> => {
  const itemIds = targets.flatMap((target) =>
    target.collectionItemId === null ? [] : [target.collectionItemId],
  );
  const [localOwners, remoteOwners] = await Promise.all([
    findItemCollectionIds(env.DB, itemIds),
    findRemoteItemCollectionIds(env.DB, itemIds),
  ]);
  if (localOwners.isErr()) {
    return err(localOwners.error);
  }
  if (remoteOwners.isErr()) {
    return err(remoteOwners.error);
  }
  const owners = { value: new Map([...localOwners.value, ...remoteOwners.value]) };
  const collectionOf = (target: CollectionTarget): string | undefined =>
    target.collectionId ??
    (target.collectionItemId === null ? undefined : owners.value.get(target.collectionItemId));
  const ids = [...new Set(targets.flatMap((target) => collectionOf(target) ?? []))];
  const [local, remote] = await Promise.all([
    findCollections(env.DB, ids),
    findRemoteCollections(env.DB, ids),
  ]);
  if (local.isErr()) {
    return err(local.error);
  }
  if (remote.isErr()) {
    return err(remote.error);
  }
  const collections = { value: [...local.value, ...remote.value] };
  const viewer = await collectionViewer(env.DB, viewerId, collections.value);
  if (viewer.isErr()) {
    return err(viewer.error);
  }
  const documents = new Map(
    collections.value.map((collection) => [
      collection.id,
      mastodonCollection(identity, collection, viewer.value),
    ]),
  );
  return ok((target) => {
    const id = collectionOf(target);
    return id === undefined ? null : (documents.get(id) ?? null);
  });
};

/** An actor's `featuredCollections` (`ap_account_featured_collections_url`). */
export const featuredCollectionsUri = (identity: InstanceIdentity, accountId: string): string =>
  `${origin(identity)}/ap/users/${accountId}/featured_collections`;

/** A collection item's ActivityPub id (`ap_account_collection_item_url`). */
export const collectionItemUri = (
  identity: InstanceIdentity,
  collection: Collection,
  itemId: string,
): string => `${origin(identity)}/ap/users/${collection.accountId}/collection_items/${itemId}`;

/** A local featured account's consent (`ap_account_feature_authorization_url`). */
export const featureAuthorizationUri = (
  identity: InstanceIdentity,
  accountId: string,
  itemId: string,
): string => `${origin(identity)}/ap/users/${accountId}/feature_authorizations/${itemId}`;

/** Rails' `iso8601`: whole seconds. */
const apTime = (instant: string): string => instant.replace(/\.\d+Z$/, "Z");

const FEATURED_COLLECTION_TERMS = {
  FeaturedCollection: "https://w3id.org/fep/7aa9#FeaturedCollection",
  FeaturedItem: "https://w3id.org/fep/7aa9#FeaturedItem",
  FeatureRequest: "https://w3id.org/fep/7aa9#FeatureRequest",
  FeatureAuthorization: "https://w3id.org/fep/7aa9#FeatureAuthorization",
  topic: { "@id": "https://w3id.org/fep/7aa9#topic", "@type": "@id" },
  featuredObject: { "@id": "https://w3id.org/fep/7aa9#featuredObject", "@type": "@id" },
  featureAuthorization: {
    "@id": "https://w3id.org/fep/7aa9#featureAuthorization",
    "@type": "@id",
  },
} as const;

/**
 * The context of a document that embeds `FeaturedCollection`s (Mastodon's
 * `discoverable`, `featured_collections`, `hashtag` and `sensitive` terms).
 */
export const featuredCollectionContext = [
  ACTIVITY_STREAMS,
  {
    toot: "http://joinmastodon.org/ns#",
    discoverable: "toot:discoverable",
    ...FEATURED_COLLECTION_TERMS,
    Hashtag: "as:Hashtag",
    sensitive: "as:sensitive",
  },
] as const satisfies ApContextJSON;

/** The context of a document with `FeaturedItem`s alone (`featured_collections`). */
export const featuredItemContext = [
  ACTIVITY_STREAMS,
  FEATURED_COLLECTION_TERMS,
] as const satisfies ApContextJSON;

/** The context of a `FeatureAuthorization` (`feature_authorizations`). */
export const featureAuthorizationContext = [
  ACTIVITY_STREAMS,
  {
    gts: "https://gotosocial.org/ns#",
    FeatureAuthorization: "https://w3id.org/fep/7aa9#FeatureAuthorization",
    interactingObject: { "@id": "gts:interactingObject", "@type": "@id" },
    interactionTarget: { "@id": "gts:interactionTarget", "@type": "@id" },
  },
] as const satisfies ApContextJSON;

/** The actor URI of an account a collection names; `undefined` when it is gone. */
export type ActorUriOf = (accountId: string) => string | undefined;

/** `ActivityPub::FeaturedItemSerializer` of a local collection's item. */
export const featuredItemObject = (
  identity: InstanceIdentity,
  collection: Collection,
  item: CollectionItem,
  actorUriOf: ActorUriOf,
): ApFeaturedItemJSON | undefined => {
  const remote = RemoteAccountId.decode(item.accountId);
  const featuredObject = remote.isOk() ? remote.value : actorUriOf(item.accountId);
  // A remote account's authorization is the one its `Accept` named.
  const featureAuthorization = remote.isOk()
    ? item.approvalUri
    : featureAuthorizationUri(identity, item.accountId, item.id);
  return featuredObject === undefined || featureAuthorization === undefined
    ? undefined
    : {
        id: collectionItemUri(identity, collection, item.id),
        type: "FeaturedItem",
        featuredObject,
        featureAuthorization,
        published: apTime(item.createdAt),
      };
};

/**
 * `ActivityPub::FeaturedCollectionSerializer`: the accepted items only, and
 * the description as `summaryMap` when the collection has a language.
 */
export const curatedCollectionObject = (
  identity: InstanceIdentity,
  collection: Collection,
  actorUriOf: ActorUriOf,
): ApCuratedCollectionJSON => {
  const accepted = collection.items.filter((item) => item.state === "accepted");
  return {
    id: collectionUri(identity, collection),
    type: "FeaturedCollection",
    totalItems: accepted.length,
    name: collection.name,
    attributedTo: actorUriOf(collection.accountId) ?? "",
    url: collectionUrl(identity, collection),
    sensitive: collection.sensitive,
    discoverable: collection.discoverable,
    published: apTime(collection.createdAt),
    updated: apTime(collection.updatedAt),
    ...(collection.language
      ? { summaryMap: { [collection.language]: collection.description } }
      : { summary: collection.description }),
    topic: collection.tagName === null ? null : hashtagObject(identity, collection.tagName),
    orderedItems: accepted.flatMap(
      (item) => featuredItemObject(identity, collection, item, actorUriOf) ?? [],
    ),
  };
};

/**
 * `FeatureAuthorizationsController#show`: `account`'s consent to its accepted
 * item `itemId`, in a local collection or a remote one; none when it has no
 * such item.
 */
export const featureAuthorizationDocument = async (
  db: D1Database,
  identity: InstanceIdentity,
  account: LocalAccount,
  itemId: string,
): Promise<Result<ApFeatureAuthorizationDocumentJSON | undefined, RepositoryError>> => {
  const [local, remote] = await Promise.all([
    findCollectionOfItem(db, itemId),
    findRemoteCollectionOfItem(db, itemId),
  ]);
  if (local.isErr()) {
    return err(local.error);
  }
  if (remote.isErr()) {
    return err(remote.error);
  }
  const collection = local.value ?? remote.value;
  const item = collection?.items.find((candidate) => candidate.id === itemId);
  if (!collection || !item || item.accountId !== account.id || item.state !== "accepted") {
    return ok(undefined);
  }
  return ok({
    "@context": featureAuthorizationContext,
    id: featureAuthorizationUri(identity, item.accountId, item.id),
    type: "FeatureAuthorization",
    interactingObject:
      collection.kind === "LocalCollection" ? collectionUri(identity, collection) : collection.uri,
    interactionTarget: InstanceIdentity.actorUrl(identity, account.username),
  });
};
