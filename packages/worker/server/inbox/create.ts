import { Hostname, type InstanceIdentity, type RemoteActor } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "../d1";
import type { FederatedFetchOptions } from "../federated-fetch";
import { handleRemotePollVote } from "../remote-poll-vote";
import { settleInvalidRemoteStatus } from "../remote-status-heal";
import { persistRemoteObject } from "../remote-status-persist";
import { findDeliveredRemoteStatus, type KnownRemoteStatus } from "../remote-status-store";
import type { InboxHandler, RemoteDelivery } from "./handler";

/**
 * Apply the object of a `Create` that `signer` sent: a vote on a local poll,
 * or a note to cache and fan out. `known` is the caller's read of the
 * object's URI, when it made one; else it is read here.
 */
export const applyRemoteCreate = async (
  env: Env,
  identity: InstanceIdentity,
  signer: RemoteActor,
  object: string | Readonly<{ id: string } & Record<string, unknown>>,
  options: FederatedFetchOptions,
  known?: KnownRemoteStatus,
): Promise<Result<void, RepositoryError>> => {
  const objectUri = typeof object === "string" ? object : object.id;
  // Mastodon's `non_matching_uri_hosts?`: an actor creates objects on its own host only.
  if (Hostname.ofUri(objectUri) !== Hostname.ofUri(signer.actorUri)) {
    return ok(undefined);
  }
  const vote = await handleRemotePollVote(env, identity, signer, object);
  if (vote.isErr()) {
    return err(vote.error);
  }
  if (vote.value.kind !== "NotAVote") {
    return ok(undefined);
  }
  let read = known;
  if (read === undefined) {
    const found = await findDeliveredRemoteStatus(env.DB, objectUri);
    if (found.isErr()) {
      if (found.error.kind !== "StoredRowInvalid") {
        return err(found.error);
      }
      const settled = await settleInvalidRemoteStatus(env, signer, found.error, {
        activity: "Create",
        raw: object,
      });
      return settled.map(() => undefined);
    }
    read = { objectUri, row: found.value };
  }
  const created = await persistRemoteObject(
    env,
    identity,
    signer,
    object,
    { ...options, delivery: "Create" },
    read,
  );
  // A storage failure: the route releases the claim and answers 5xx, so the sender redelivers.
  return created.map(() => undefined);
};

export const receiveRemoteCreate: InboxHandler<RemoteDelivery<"Create">> = async ({
  env,
  identity,
  signer,
  received,
  allowHosts,
  blockedHosts,
  fetchSigner,
}) =>
  applyRemoteCreate(env, identity, signer, received.object, {
    allowHosts,
    blockedHosts,
    fetchSigner,
  });
