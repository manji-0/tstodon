import { assertNever } from "@tstodon/core";
import { Hostname, type InstanceIdentity, type RemoteActor } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountByUsername } from "../account-store";
import type { RepositoryError } from "../d1";
import type { ReceivedActivity } from "../activity-forward";
import type { FederatedFetchOptions } from "../federated-fetch";
import { deliverHeldRemoteNote } from "../held-remote-note-delivery";
import { handleRemotePollVote } from "../remote-poll-vote";
import { settleInvalidRemoteStatus } from "../remote-status-heal";
import { persistRemoteObject } from "../remote-status-persist";
import { findDeliveredRemoteStatus, type KnownRemoteStatus } from "../remote-status-store";
import type { InboxHandler, InboxTarget, RemoteDelivery } from "./handler";

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
  options: FederatedFetchOptions & Readonly<{ forward?: ReceivedActivity; deliveredTo?: string }>,
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
  if (created.isErr()) {
    return err(created.error);
  }
  // `Create#create_status`: a status held already, by the actor that sends
  // it, is postprocessed for the personal inbox it came to.
  const held = read.row;
  return held !== undefined &&
    held.actorUri === signer.actorUri &&
    options.deliveredTo !== undefined
    ? deliverHeldRemoteNote(env, identity, held, options.deliveredTo)
    : ok(undefined);
};

/**
 * The local account whose personal inbox a delivery came to, as Mastodon's
 * `delivered_to_account_id`; none for the shared inbox, or a username no
 * account holds.
 */
const inboxOwner = async (
  db: D1Database,
  inbox: InboxTarget,
): Promise<Result<string | undefined, RepositoryError>> => {
  switch (inbox.kind) {
    case "Shared":
      return ok(undefined);
    case "Personal":
      return (await findAccountByUsername(db, inbox.username)).map((account) => account?.id);
    default:
      return assertNever(inbox);
  }
};

export const receiveRemoteCreate: InboxHandler<RemoteDelivery<"Create">> = async ({
  env,
  identity,
  signer,
  inbox,
  received,
  body,
  allowHosts,
  blockedHosts,
  fetchSigner,
}) => {
  const owner = await inboxOwner(env.DB, inbox);
  if (owner.isErr()) {
    return err(owner.error);
  }
  return applyRemoteCreate(env, identity, signer, received.object, {
    allowHosts,
    blockedHosts,
    fetchSigner,
    forward: { kind: "Create", body },
    ...(owner.value === undefined ? {} : { deliveredTo: owner.value }),
  });
};
