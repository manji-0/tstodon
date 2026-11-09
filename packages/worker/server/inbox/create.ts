import { ok } from "neverthrow";
import { enqueueHomeFanOut } from "../home-fan-out";
import { enqueuePublicFanOut } from "../public-fan-out";
import { handleRemotePollVote } from "../remote-poll-vote";
import { persistRemoteObject } from "../remote-status-persist";
import type { InboxHandler, RemoteDelivery } from "./handler";

/** A `Create` is a vote on a local poll, or a note to cache and fan out. */
export const receiveRemoteCreate: InboxHandler<RemoteDelivery<"Create">> = async ({
  env,
  identity,
  signer,
  received,
  allowHosts,
  fetchSigner,
}) => {
  const vote = await handleRemotePollVote(env, identity, signer, received.object);
  if (vote.kind !== "NotAVote") {
    return ok(undefined);
  }
  const created = await persistRemoteObject(env, identity, signer, received.object, {
    allowHosts,
    fetchSigner,
    notifyMentions: true,
  });
  // A redelivered Create finds the note cached and tells followers again,
  // which clients take as the same status.
  if (created.isOk() && created.value?.actorUri === signer.actorUri) {
    await enqueueHomeFanOut(env, {
      event: "update",
      entryId: created.value.id,
      author: { kind: "RemoteActor", actorUri: signer.actorUri },
    });
    if (created.value.visibility.kind === "Public") {
      await enqueuePublicFanOut(env, { event: "update", entryId: created.value.id });
    }
  }
  return ok(undefined);
};
