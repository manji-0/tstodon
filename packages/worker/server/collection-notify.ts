import type { Collection } from "@tstodon/domain";
import { ok, type Result } from "neverthrow";
import { type RepositoryError, runD1 } from "./d1";
import { notifyAccount } from "./notify";

/**
 * `added_to_collection` for a local account a collection now features
 * (`LocalNotificationWorker` with the item as the activity), from the owner.
 */
export const notifyAddedToCollection = (
  env: Env,
  collection: Collection,
  itemId: string,
  accountId: string,
): Promise<Result<void, RepositoryError>> =>
  notifyAccount(env, {
    accountId,
    fromAccountId: collection.accountId,
    kind: "added_to_collection",
    collectionItemId: itemId,
  });

/**
 * `collection_update` for each local account the collection features and
 * that accepted (`NotifyOfCollectionUpdateService`). As
 * `LocalNotificationWorker` does for an update, the account's earlier
 * `collection_update` about the collection is replaced.
 */
export const notifyCollectionUpdate = async (
  env: Env,
  collection: Collection,
): Promise<Result<void, RepositoryError>> => {
  for (const item of collection.items.filter((candidate) => candidate.state === "accepted")) {
    const cleared = await runD1(() =>
      env.DB.prepare(
        "DELETE FROM notifications WHERE account_id = ? AND collection_id = ? AND kind = 'collection_update'",
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
      collectionId: collection.id,
    });
    if (notified.isErr()) {
      return notified;
    }
  }
  return ok(undefined);
};
