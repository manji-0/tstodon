import { assertNever } from "@tstodon/core";
import type { LocalAccount, RemoteActor } from "@tstodon/domain";
import { ok, type Result } from "neverthrow";
import { receiveRemoteFlag } from "../remote-flag";
import { applyRemoteMove } from "../remote-move";
import { applyRemoteUpdate, type RemoteUpdateError } from "../remote-update";
import { receiveLocalAnnounce, receiveRemoteAnnounce } from "./announce";
import { receiveAnswer } from "./answer";
import { receiveRemoteBlock } from "./block";
import { receiveRemoteCreate } from "./create";
import { receiveCollectionUpdate, receiveFeatureRequest } from "./curated-collection";
import { receiveRemoteDelete } from "./delete";
import { receiveRemoteAdd, receiveRemoteRemove } from "./featured";
import { receiveLocalFollow, receiveRemoteFollow } from "./follow";
import type { InboxReceipt, InboxSigner } from "./handler";
import { receiveLocalLike, receiveRemoteLike } from "./like";
import { receiveQuoteRequest } from "./quote-request";
import { receiveLocalUndo, receiveRemoteUndo } from "./undo";

/**
 * An `Err` is a failure the sender should retry: storage, or a server an
 * `Update` had to read that did not answer (`Unavailable`).
 */
export type InboxApplyError = RemoteUpdateError;

type Dispatched = Promise<Result<void, InboxApplyError>>;

/**
 * The object an `Update` is applied with: as received, but for a forwarded
 * `Update` of its actor, where the actor's URI makes `applyRemoteUpdate`
 * fetch the actor's own document rather than trust the embedded one.
 */
const updatedObject = (receipt: InboxReceipt, signer: RemoteActor) => {
  const object = receipt.received.object;
  const objectId = typeof object === "string" ? object : object.id;
  return receipt.route.kind === "Forwarded" && objectId === signer.actorUri
    ? signer.actorUri
    : object;
};

const dispatchRemote = async (receipt: InboxReceipt, signer: RemoteActor): Dispatched => {
  const { activity, env, identity } = receipt;
  const delivery = { ...receipt, signer };
  switch (activity.kind) {
    case "Create":
      return receiveRemoteCreate({ ...delivery, activity });
    case "Update": {
      const collection = await receiveCollectionUpdate({ ...delivery, activity });
      if (collection.isErr() || collection.value) {
        return collection.map(() => undefined);
      }
      // A forwarded actor `Update` is not taken as it came: the actor's own
      // document is fetched instead.
      return applyRemoteUpdate(env, identity, signer, updatedObject(receipt, signer), {
        allowHosts: receipt.allowHosts,
        blockedHosts: receipt.blockedHosts,
        fetchSigner: receipt.fetchSigner,
        forward: { kind: "Update", body: receipt.body },
      });
    }
    case "Delete":
      return receiveRemoteDelete({ ...delivery, activity });
    case "Follow":
      return receiveRemoteFollow({ ...delivery, activity });
    case "Undo":
      return receiveRemoteUndo({ ...delivery, activity });
    case "Accept":
    case "Reject":
      return receiveAnswer({ ...delivery, activity });
    case "Block":
      return receiveRemoteBlock({ ...delivery, activity });
    case "Move":
      return applyRemoteMove(env, identity, signer, receipt.received, {
        allowHosts: receipt.allowHosts,
        blockedHosts: receipt.blockedHosts,
        fetchSigner: receipt.fetchSigner,
      });
    case "Like":
      return receiveRemoteLike({ ...delivery, activity });
    case "Announce":
      return receiveRemoteAnnounce({ ...delivery, activity });
    case "Flag":
      return receiveRemoteFlag(env, identity, signer, receipt.body);
    case "QuoteRequest":
      return receiveQuoteRequest({ ...delivery, activity });
    case "FeatureRequest":
      return receiveFeatureRequest({ ...delivery, activity });
    case "Add":
      return receiveRemoteAdd({ ...delivery, activity });
    case "Remove":
      return receiveRemoteRemove({ ...delivery, activity });
    default:
      return assertNever(activity);
  }
};

/** A local account signs only relationship and interaction activities here. */
const dispatchLocal = async (receipt: InboxReceipt, signer: LocalAccount): Dispatched => {
  const { activity } = receipt;
  const delivery = { ...receipt, signer };
  switch (activity.kind) {
    case "Follow":
      return receiveLocalFollow({ ...delivery, activity });
    case "Undo":
      return receiveLocalUndo({ ...delivery, activity });
    case "Like":
      return receiveLocalLike({ ...delivery, activity });
    case "Announce":
      return receiveLocalAnnounce({ ...delivery, activity });
    case "Create":
    case "Update":
    case "Delete":
    case "Accept":
    case "Reject":
    case "Block":
    case "Move":
    case "Flag":
    case "QuoteRequest":
    case "FeatureRequest":
    case "Add":
    case "Remove":
      return ok(undefined);
    default:
      return assertNever(activity);
  }
};

/** Apply a verified, first-seen inbox activity for whoever signed it. */
export const dispatchInbox = (receipt: InboxReceipt, signer: InboxSigner): Dispatched => {
  switch (signer.kind) {
    case "Remote":
      return dispatchRemote(receipt, signer.actor);
    case "Local":
      return dispatchLocal(receipt, signer.account);
    default:
      return assertNever(signer);
  }
};
