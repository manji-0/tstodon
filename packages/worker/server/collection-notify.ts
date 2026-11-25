import type { Collection, RemoteCollection } from "@tstodon/domain";
import { ok, type Result } from "neverthrow";
import { type RepositoryError, runD1 } from "./d1";
import { notifyAccount } from "./notify";
import { RemoteAccountId } from "./remote-account-id";

/**
 * `added_to_collection` for a local account a collection now features
 * (`LocalNotificationWorker` with the item as the activity), from the owner.
 */
export const notifyAddedToCollection = (
  env: Env,
  collection: Collection | RemoteCollection,
  itemId: string,
  accountId: string,
): Promise<Result<void, RepositoryError>> =>
  notifyAccount(env, {
    accountId,
    fromAccountId: collection.accountId,
    ...(collection.kind === "RemoteCollection" ? { fromActorUri: collection.actorUri } : {}),
    kind: "added_to_collection",
    collectionItemId: itemId,
  });

/**
 * `collection_update` for each local account the collection features and
 * that accepted (`NotifyOfCollectionUpdateService`), from its owner. As
 * `LocalNotificationWorker` does for an update, the account's earlier
 * `collection_update` about the collection is replaced.
 */
export const notifyCollectionUpdate = async (
  env: Env,
  collection: Collection | RemoteCollection,
): Promise<Result<void, RepositoryError>> => {
  const about =
    collection.kind === "RemoteCollection"
      ? { fromActorUri: collection.actorUri, remoteCollectionId: collection.id }
      : { collectionId: collection.id };
  const members = collection.items.filter(
    (item) => item.state === "accepted" && RemoteAccountId.decode(item.accountId).isErr(),
  );
  for (const item of members) {
    const cleared = await runD1(() =>
      env.DB.prepare(
        `DELETE FROM notifications WHERE account_id = ?1 AND kind = 'collection_update'
           AND (collection_id = ?2 OR remote_collection_id = ?2)`,
      )
        .bind(item.accountId, collection.id)
        .run(),
    );
    if (cleared.isErr()) {
      return cleared.map(() => undefined);
    }
    const notified = await notifyAccount(env, {
      accountId: item.accountId,
      fromAccountId: collection.accountId,
      kind: "collection_update",
      ...about,
    });
    if (notified.isErr()) {
      return notified;
    }
  }
  return ok(undefined);
};
