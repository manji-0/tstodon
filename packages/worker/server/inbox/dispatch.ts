import { assertNever } from "@tstodon/core";
import type { LocalAccount, RemoteActor } from "@tstodon/domain";
import { ok, type Result } from "neverthrow";
import type { RepositoryError } from "../d1";
import { receiveRemoteFlag } from "../remote-flag";
import { applyRemoteMove } from "../remote-move";
import { applyRemoteUpdate } from "../remote-update";
import { receiveLocalAnnounce, receiveRemoteAnnounce } from "./announce";
import { receiveAnswer } from "./answer";
import { receiveRemoteBlock } from "./block";
import { receiveRemoteCreate } from "./create";
import { receiveRemoteDelete } from "./delete";
import { receiveLocalFollow, receiveRemoteFollow } from "./follow";
import type { InboxReceipt, InboxSigner } from "./handler";
import { receiveLocalLike, receiveRemoteLike } from "./like";
import { receiveQuoteRequest } from "./quote-request";
import { receiveLocalUndo, receiveRemoteUndo } from "./undo";

type Dispatched = Promise<Result<void, RepositoryError>>;

const dispatchRemote = async (receipt: InboxReceipt, signer: RemoteActor): Dispatched => {
  const { activity, env, identity } = receipt;
  const delivery = { ...receipt, signer };
  switch (activity.kind) {
    case "Create":
      return receiveRemoteCreate({ ...delivery, activity });
    case "Update":
      await applyRemoteUpdate(env, identity, signer, receipt.received.object, {
        allowHosts: receipt.allowHosts,
      });
      return ok(undefined);
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
      });
    case "Like":
      return receiveRemoteLike({ ...delivery, activity });
    case "Announce":
      return receiveRemoteAnnounce({ ...delivery, activity });
    case "Flag":
      return receiveRemoteFlag(env, identity, signer, receipt.body);
    case "QuoteRequest":
      return receiveQuoteRequest({ ...delivery, activity });
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
