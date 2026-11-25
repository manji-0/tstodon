import { Hostname, type RemoteActor } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountById } from "../account-store";
import { refId } from "../activitypub-wire";
import { nowIso } from "../clock";
import { federateCollection } from "../collection-federation";
import { acceptRemoteItem, findRemoteItem, setCollectionItemState } from "../collection-store";
import type { RepositoryError } from "../d1";
import type { RemoteDelivery } from "./handler";

/**
 * The authorization an `Accept` names in `result`, as `accept_feature_request!`
 * takes it: an http(s) URI on the signer's host.
 */
const approvalOf = (result: unknown, signer: RemoteActor): string | undefined => {
  const uri = refId(Array.isArray(result) ? result[0] : result);
  if (uri === undefined || !/^https?:\/\//i.test(uri)) {
    return undefined;
  }
  return Hostname.ofUri(uri) === Hostname.ofUri(signer.actorUri) ? uri : undefined;
};

/**
 * A remote account answers a local collection's `FeatureRequest`, as
 * Mastodon's `Accept#accept_feature_request!` and `Reject#reject_feature_request!`:
 * an `Accept` stores the authorization and sends the item's `Add` to the
 * collection's reach, a `Reject` marks the item rejected. `false` when the
 * answer names no such request, for the other answers to try.
 */
export const receiveFeatureAnswer = async (
  delivery: RemoteDelivery<"Accept" | "Reject">,
): Promise<Result<boolean, RepositoryError>> => {
  const { env, signer, activity } = delivery;
  const found = await findRemoteItem(env.DB, {
    column: "activity",
    uri: activity.object,
    actorUri: signer.actorUri,
  });
  if (found.isErr()) {
    return err(found.error);
  }
  if (found.value === undefined) {
    return ok(false);
  }
  const { collection, itemId } = found.value;
  if (activity.kind === "Reject") {
    const rejected = await setCollectionItemState(env.DB, itemId, "rejected", nowIso());
    return rejected.map(() => true);
  }
  const approval = approvalOf(delivery.received.result, signer);
  if (approval === undefined) {
    return ok(true);
  }
  const accepted = await acceptRemoteItem(env.DB, itemId, approval, nowIso());
  if (accepted.isErr()) {
    return err(accepted.error);
  }
  const item = collection.items.find((candidate) => candidate.id === itemId);
  const owner = await findAccountById(env.DB, collection.accountId);
  if (item && owner.isOk() && owner.value) {
    await federateCollection(env, owner.value, {
      kind: "ItemAdded",
      collection,
      item: { ...item, state: "accepted", approvalUri: approval },
    });
  }
  return ok(true);
};

/**
 * A remote account's `Delete` of the authorization it gave a local
 * collection (`Delete#delete_feature_authorization!`): the item is revoked
 * and its `Remove` sent to the collection's reach. `false` when it names
 * none.
 */
export const revokeRemoteFeatureAuthorization = async (
  env: Env,
  signer: RemoteActor,
  objectUri: string,
): Promise<Result<boolean, RepositoryError>> => {
  const found = await findRemoteItem(env.DB, {
    column: "approval",
    uri: objectUri,
    actorUri: signer.actorUri,
  });
  if (found.isErr()) {
    return err(found.error);
  }
  if (found.value === undefined) {
    return ok(false);
  }
  const { collection, itemId } = found.value;
  const revoked = await setCollectionItemState(env.DB, itemId, "revoked", nowIso());
  if (revoked.isErr()) {
    return err(revoked.error);
  }
  const item = collection.items.find((candidate) => candidate.id === itemId);
  const owner = await findAccountById(env.DB, collection.accountId);
  if (item && owner.isOk() && owner.value) {
    await federateCollection(env, owner.value, { kind: "ItemRemoved", collection, item });
  }
  return ok(true);
};
