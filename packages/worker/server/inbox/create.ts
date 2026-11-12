import { err, ok } from "neverthrow";
import { handleRemotePollVote } from "../remote-poll-vote";
import { persistRemoteObject, settleInvalidRemoteStatus } from "../remote-status-persist";
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
    return known.error.kind === "StoredRowInvalid"
      ? settleInvalidRemoteStatus(env, signer, known.error, received.object)
      : err(known.error);
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
