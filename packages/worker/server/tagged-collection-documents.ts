import type { ApiCollectionJSON } from "@tstodon/api";
import type { ApCuratedCollectionJSON } from "@tstodon/api/activitypub";
import {
  type Collection,
  InstanceIdentity,
  type RemoteCollection,
  StatusTarget,
  type StatusTargetValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountsByIds } from "./account-store";
import { findCollections } from "./collection-store";
import {
  type ActorUriOf,
  collectionViewer,
  mastodonCollection,
  taggedCollectionObject,
} from "./collection-documents";
import type { RepositoryError } from "./d1";
import { findRemoteCollections } from "./remote-curated-collection-store";
import {
  listTaggedCollections,
  type TaggedCollectionRef,
  taggedKey,
} from "./tagged-collection-store";

type Tagged = Readonly<{
  collectionsOf: (status: StatusTargetValue) => ReadonlyArray<Collection | RemoteCollection>;
  collections: ReadonlyArray<Collection | RemoteCollection>;
}>;

/**
 * The collections each of `statuses` tags, still stored, in the order they
 * were tagged (`Status#tagged_objects`). The tags, then the local and the
 * remote collections, are read once for all the statuses; statuses that
 * tag none cost the first read only.
 */
const loadTagged = async (
  db: D1Database,
  statuses: ReadonlyArray<StatusTargetValue>,
): Promise<Result<Tagged, RepositoryError>> => {
  const tagged = await listTaggedCollections(db, statuses);
  if (tagged.isErr()) {
    return err(tagged.error);
  }
  if (tagged.value.size === 0) {
    return ok({ collectionsOf: () => [], collections: [] });
  }
  const refs = [...tagged.value.values()].flat();
  const idsOf = (kind: TaggedCollectionRef["kind"]) => [
    ...new Set(refs.flatMap((ref) => (ref.kind === kind ? [ref.id] : []))),
  ];
  const [local, remote] = await Promise.all([
    findCollections(db, idsOf("LocalCollection")),
    findRemoteCollections(db, idsOf("RemoteCollection")),
  ]);
  if (local.isErr()) {
    return err(local.error);
  }
  if (remote.isErr()) {
    return err(remote.error);
  }
  const byKey = new Map<string, Collection | RemoteCollection>(
    [...local.value, ...remote.value].map((collection) => [
      `${collection.kind}:${collection.id}`,
      collection,
    ]),
  );
  return ok({
    collectionsOf: (status) =>
      (tagged.value.get(taggedKey(status)) ?? []).flatMap(
        (ref) => byKey.get(`${ref.kind}:${ref.id}`) ?? [],
      ),
    collections: [...byKey.values()],
  });
};

/**
 * `REST::StatusSerializer#tagged_collections` of each of `statuses`, for the
 * viewer: every collection it tags, discoverable or not, with the items the
 * viewer may see (`Collection#items_for`). A page of statuses costs a fixed
 * number of statements, one when none tags a collection. A read that fails
 * renders none.
 */
export const taggedCollectionDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  viewerId: string | undefined,
  statuses: ReadonlyArray<StatusTargetValue>,
): Promise<(status: StatusTargetValue) => ApiCollectionJSON[]> => {
  const tagged = await loadTagged(env.DB, statuses);
  if (tagged.isErr() || tagged.value.collections.length === 0) {
    return () => [];
  }
  const { collections, collectionsOf } = tagged.value;
  const viewer = await collectionViewer(env.DB, viewerId, collections);
  if (viewer.isErr()) {
    return () => [];
  }
  const documents = new Map(
    collections.map((collection) => [
      collection,
      mastodonCollection(identity, collection, viewer.value),
    ]),
  );
  return (status) => collectionsOf(status).flatMap((collection) => documents.get(collection) ?? []);
};

/**
 * The `FeaturedCollection` tags of each of the local notes `noteIds`
 * (`NoteSerializer#virtual_tags`), keyed by note id, read at once for all
 * of them.
 */
export const loadNotesTaggedCollections = async (
  db: D1Database,
  identity: InstanceIdentity,
  noteIds: ReadonlyArray<string>,
): Promise<
  Result<ReadonlyMap<string, ReadonlyArray<ApCuratedCollectionJSON>>, RepositoryError>
> => {
  const targets = noteIds.flatMap((id) => {
    const target = StatusTarget.parse({ kind: "LocalStatus", statusId: id });
    return target.isOk() ? [target.value] : [];
  });
  const tagged = await loadTagged(db, targets);
  if (tagged.isErr()) {
    return err(tagged.error);
  }
  const { collections, collectionsOf } = tagged.value;
  const accounts = await findAccountsByIds(
    db,
    collections.flatMap((collection) => [
      collection.accountId,
      ...collection.items.map((item) => item.accountId),
    ]),
  );
  if (accounts.isErr()) {
    return err(accounts.error);
  }
  const actorUriOf: ActorUriOf = (accountId) => {
    const account = accounts.value.get(accountId);
    return account && InstanceIdentity.actorUrl(identity, account.username);
  };
  return ok(
    new Map(
      targets.map((target) => [
        target.statusId,
        collectionsOf(target).map((collection) =>
          taggedCollectionObject(identity, collection, actorUriOf),
        ),
      ]),
    ),
  );
};
