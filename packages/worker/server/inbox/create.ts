import { err, ok } from "neverthrow";
import { handleRemotePollVote } from "../remote-poll-vote";
import { settleInvalidRemoteStatus } from "../remote-status-heal";
import { persistRemoteObject } from "../remote-status-persist";
import { findDeliveredRemoteStatus } from "../remote-status-store";
import type { InboxHandler, RemoteDelivery } from "./handler";

/** A `Create` is a vote on a local poll, or a note to cache and fan out. */
export const receiveRemoteCreate: InboxHandler<RemoteDelivery<"Create">> = async ({
  env,
  identity,
  signer,
  received,
  allowHosts,
  blockedHosts,
  fetchSigner,
}) => {
  const vote = await handleRemotePollVote(env, identity, signer, received.object);
  if (vote.isErr()) {
    return err(vote.error);
  }
  if (vote.value.kind !== "NotAVote") {
    return ok(undefined);
  }
  const objectUri = typeof received.object === "string" ? received.object : received.object.id;
  const known = await findDeliveredRemoteStatus(env.DB, objectUri);
  if (known.isErr()) {
    if (known.error.kind !== "StoredRowInvalid") {
      return err(known.error);
    }
    const settled = await settleInvalidRemoteStatus(env, signer, known.error, {
      activity: "Create",
      raw: received.object,
    });
    return settled.map(() => undefined);
  }
  const created = await persistRemoteObject(
    env,
    identity,
    signer,
    received.object,
    { allowHosts, blockedHosts, fetchSigner, delivery: "Create" },
    { objectUri, row: known.value },
  );
  // A storage failure: the route releases the claim and answers 5xx, so the sender redelivers.
  return created.map(() => undefined);
};
