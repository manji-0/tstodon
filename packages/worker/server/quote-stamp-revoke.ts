import { schemaResult } from "@tstodon/core";
import {
  type InstanceIdentity,
  type LocalAccount,
  type LocalStatus as LocalStatusValue,
  RemoteActor,
  StatusTarget,
  type ThreadStatus,
} from "@tstodon/domain";
import { err, ok } from "neverthrow";
import { z } from "zod";
import { findAccountById } from "./account-store";
import { localNoteRef } from "./activitypub";
import { enqueueActivityToInboxes } from "./delivery";
import { type FoundStatus, foundStatusTarget } from "./found-status";
import {
  localQuoteAuthorization,
  quoteAuthorizationDeleteActivity,
} from "./quote-authorization-document";
import { findRemoteActorByUri, listAcceptedRemoteFollowerInboxes } from "./remote-actor-store";
import { listStatusInteractorInboxes } from "./remote-interaction-store";
import { statusTargetRef } from "./quote-uri";
import { listLocalBoosterAccountIds } from "./status-interaction-store";
import {
  quoteStampReach,
  type StampDeleteForwardOperations,
  stampDeleteForward,
  type StatusReachOperations,
} from "./status-reach";
import { findThreadParent } from "./thread-context";

/** A found status as a thread node. */
const threadStatusOf = (found: FoundStatus): ThreadStatus =>
  found.kind === "LocalStatus"
    ? { kind: "Local", status: found.status }
    : { kind: "Remote", status: found.status };

const targetOf = (status: ThreadStatus) =>
  status.kind === "Local"
    ? StatusTarget.local(status.status.id)
    : StatusTarget.remote(status.status.id);

const listRemoteFollowerInboxes = (env: Env) => (accountId: string) =>
  listAcceptedRemoteFollowerInboxes(env.DB, accountId);

const statusReachOperations = (env: Env, identity: InstanceIdentity): StatusReachOperations => ({
  listInteractorInboxes: async (status) => {
    if (status.kind === "Remote") {
      return listStatusInteractorInboxes(env.DB, {
        kind: "Remote",
        statusId: status.status.id,
        uri: status.status.objectUri,
      });
    }
    const author = await findAccountById(env.DB, status.status.accountId);
    if (author.isErr()) {
      return err(author.error);
    }
    if (!author.value) {
      return ok([]);
    }
    return listStatusInteractorInboxes(env.DB, {
      kind: "Local",
      statusId: status.status.id,
      uri: localNoteRef(identity, author.value, status.status.id).uri,
    });
  },
  listRemoteFollowerInboxes: listRemoteFollowerInboxes(env),
  findRemoteActorInbox: async (actorUri) =>
    (await findRemoteActorByUri(env.DB, actorUri)).map((actor) =>
      actor ? RemoteActor.deliveryInbox(actor) : undefined,
    ),
  findThreadParent: (status) => findThreadParent(env.DB, identity, status),
});

/**
 * Withdraw the stamp of a revoked quote of a local status, as Mastodon's
 * `RevokeQuoteService`: one `Delete` signed by the quoted author, to
 * {@link quoteStampReach}. Best effort: the revoke stands either way.
 */
export const federateStampDeletion = async (
  env: Env,
  identity: InstanceIdentity,
  quotedAuthor: LocalAccount,
  quoted: LocalStatusValue,
  quoting: FoundStatus,
  quoteId: string,
): Promise<void> => {
  const target = localNoteRef(identity, quotedAuthor, quoted.id);
  const interacting = await statusTargetRef(env, identity, foundStatusTarget(quoting));
  if (!interacting) {
    return;
  }
  const reach = await quoteStampReach(
    statusReachOperations(env, identity),
    { kind: "Local", status: quoted },
    threadStatusOf(quoting),
  );
  const activity = quoteAuthorizationDeleteActivity(
    localQuoteAuthorization(target, quoteId, interacting.uri),
  );
  const enqueued = reach.isErr()
    ? reach
    : await enqueueActivityToInboxes(env, quotedAuthor.id, "Delete", activity, reach.value);
  if (enqueued.isErr()) {
    console.error(JSON.stringify({ kind: "QuoteStampDeleteNotFederated", quoteId }));
  }
};

/** An activity that carries a Linked Data signature, which lets another server check it forwarded. */
const parseLdSigned = schemaResult(
  z.object({ signature: z.record(z.string(), z.unknown()) }).passthrough(),
);

const forwardOperations = (env: Env, identity: InstanceIdentity): StampDeleteForwardOperations => ({
  listLocalBoosterAccountIds: (status) => listLocalBoosterAccountIds(env.DB, targetOf(status)),
  listRemoteFollowerInboxes: listRemoteFollowerInboxes(env),
  findThreadParent: (status) => findThreadParent(env.DB, identity, status),
});

/**
 * Forward an inbound stamp `Delete` to the audience of the quoting status
 * this server distributed ({@link stampDeleteForward}), as Mastodon's
 * `Delete#revoke_quote` does with `ActivityPub::Forwarder`. As there, only a
 * body with a Linked Data `signature` is forwarded, as received, since the
 * receivers check that signature rather than ours. Best effort.
 */
export const forwardStampDelete = async (
  env: Env,
  identity: InstanceIdentity,
  sender: RemoteActor,
  body: unknown,
  quoting: ThreadStatus,
): Promise<void> => {
  const signed = parseLdSigned(body);
  if (signed.isErr()) {
    return;
  }
  const forward = await stampDeleteForward(forwardOperations(env, identity), quoting, sender);
  if (forward.isErr() || forward.value === undefined) {
    return;
  }
  const enqueued = await enqueueActivityToInboxes(
    env,
    forward.value.signerAccountId,
    "Delete",
    signed.value,
    forward.value.inboxes,
  );
  if (enqueued.isErr()) {
    console.error(
      JSON.stringify({ kind: "QuoteStampDeleteNotForwarded", statusId: quoting.status.id }),
    );
  }
};
