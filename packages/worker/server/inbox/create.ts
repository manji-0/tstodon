import { RealtimeWindow } from "@tstodon/domain";
import { err, ok } from "neverthrow";
import { nowInstant } from "../clock";
import { startHomeFanOut } from "../home-fan-out";
import { startPublicFanOut } from "../public-fan-out";
import { handleRemotePollVote } from "../remote-poll-vote";
import { persistRemoteObject } from "../remote-status-persist";
import { findRemoteStatusByObjectUri } from "../remote-status-store";
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
  if (vote.kind !== "NotAVote") {
    return ok(undefined);
  }
  const objectUri = typeof received.object === "string" ? received.object : received.object.id;
  const known = await findRemoteStatusByObjectUri(env.DB, objectUri);
  if (known.isErr()) {
    return err(known.error);
  }
  const created = await persistRemoteObject(
    env,
    identity,
    signer,
    received.object,
    { allowHosts, blockedHosts, fetchSigner, notifyMentions: true },
    { objectUri, row: known.value },
  );
  // Streaming is for a note stored now and published recently, as Mastodon's
  // `Status::REAL_TIME_WINDOW`: a redelivered Create, or an old note arriving
  // late, would show up in clients as a new status. Notifications still go out.
  if (
    created.isOk() &&
    known.value === undefined &&
    created.value?.actorUri === signer.actorUri &&
    RealtimeWindow.contains(created.value.publishedAt, nowInstant())
  ) {
    await startHomeFanOut(env, {
      event: "update",
      entryId: created.value.id,
      author: { kind: "RemoteActor", actorUri: signer.actorUri },
    });
    if (created.value.visibility.kind === "Public") {
      await startPublicFanOut(env, { event: "update", entryId: created.value.id });
    }
  }
  return ok(undefined);
};
