import type { ApiCollectionJSON, CollectionAccountItem } from "@tstodon/api";
import { Collection, type CollectionItem, type InstanceIdentity } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { blockedAccountIds, findCollections, findItemCollectionIds } from "./collection-store";
import type { RepositoryError } from "./d1";
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
  collection: Collection,
  viewer: CollectionViewer,
): ApiCollectionJSON => {
  const items = Collection.itemsFor(collection, viewer.id, viewer.blocking);
  return {
    id: collection.id,
    uri: collectionUri(identity, collection),
    name: collection.name,
    description: collection.description,
    language: collection.language,
    account_id: collection.accountId,
    local: true,
    sensitive: collection.sensitive,
    discoverable: collection.discoverable,
    url: collectionUrl(identity, collection),
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
  collections: ReadonlyArray<Collection>,
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
  const owners = await findItemCollectionIds(env.DB, itemIds);
  if (owners.isErr()) {
    return err(owners.error);
  }
  const collectionOf = (target: CollectionTarget): string | undefined =>
    target.collectionId ??
    (target.collectionItemId === null ? undefined : owners.value.get(target.collectionItemId));
  const ids = [...new Set(targets.flatMap((target) => collectionOf(target) ?? []))];
  const collections = await findCollections(env.DB, ids);
  if (collections.isErr()) {
    return err(collections.error);
  }
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
