import {
  type InstanceIdentity,
  type LocalAccount,
  type LocalStatusValue,
  RemoteActor,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { noteDeleteActivity, noteDocument } from "./activitypub";
import type { RepositoryError } from "./d1";
import { enqueueActivityToInboxes, enqueueLocalActivity } from "./delivery";
import { deliveredActivity } from "./own-activity-signature";
import { findRemoteActorsByUris, listAcceptedRemoteFollowerInboxes } from "./remote-actor-store";
import { statusDeleteReach } from "./status-reach";
import { statusReachOperations } from "./status-reach-operations";
import { announceRemovedBoosts, startHomeFanOut } from "./home-fan-out";
import { loadNoteMentions } from "./mention-resolve";
import { outboundAudience, reachesRemoteInboxes } from "./outbox-job";
import { startPublicFanOut } from "./public-fan-out";
import { loadNoteReply } from "./reply-target";
import { deleteStatus, type StatusMediaOnDelete } from "./status-store";
import { deleteMediaObjects } from "./media-objects";
import { loadNoteQuotePolicy } from "./quote-policy-name";
import { publishToAccount } from "./stream-publish";

/**
 * Delete one of the account's own statuses and tell everyone: the account's
 * streams, the home and public timelines, and the remote servers a `Delete`
 * reaches: the author's followers and those it addresses, then the rest of
 * {@link statusDeleteReach} as a second activity. `false` means no status
 * of the account had that id. Used by
 * `DELETE /api/v1/statuses/:id`, the automated post deletion and moderation.
 * With `media: "Delete"` the status's media rows go with it and their
 * objects are removed from the bucket; `Keep` leaves the media unattached
 * for a redraft (`delete_media` not set), for the media sweep to remove.
 */
export const deleteLocalStatus = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  status: LocalStatusValue,
  media: StatusMediaOnDelete,
): Promise<Result<boolean, RepositoryError>> => {
  // The note's addressing comes from its mentions, which are deleted with it.
  const tombstone =
    status.kind === "LocalNote" && status.accountId === account.id
      ? noteDeleteActivity(
          noteDocument(identity, account, status, {
            mentions: await loadNoteMentions(env.DB, identity, status.id),
            reply: await loadNoteReply(env.DB, identity, status),
            media: { attachments: [], authorSensitized: false },
            quotePolicy: await loadNoteQuotePolicy(env.DB, account, status),
            emojis: [],
            taggedCollections: [],
          }),
        )
      : undefined;
  // Read before the boosts and interactions go with the status.
  const reach = tombstone
    ? await statusDeleteReach(statusReachOperations(env, identity), { kind: "Local", status })
    : ok([]);
  const deleted = await deleteStatus(env.DB, status.id, account.id, media);
  if (deleted.isErr()) {
    return err(deleted.error);
  }
  if (!deleted.value) {
    return ok(false);
  }
  // A handful of objects (the media and their previews): deleted inline.
  await deleteMediaObjects(env, deleted.value.mediaObjectKeys, { statusId: status.id });
  await announceRemovedBoosts(env, deleted.value.boosts);
  await publishToAccount(env, account.id, { kind: "delete", statusId: status.id });
  await startHomeFanOut(env, {
    event: "delete",
    entryId: status.id,
    author: { kind: "LocalAccount", accountId: account.id },
  });
  if (status.kind === "LocalNote" && status.visibility.kind === "Public") {
    await startPublicFanOut(env, { event: "delete", entryId: status.id });
  }
  if (!tombstone) {
    return ok(true);
  }
  // The second `Delete` goes to the reach the first, to the followers and
  // the addressed actors, does not cover. A lookup that fails only sends it
  // to them twice.
  const followers = await listAcceptedRemoteFollowerInboxes(env.DB, account.id);
  const addressed = await findRemoteActorsByUris(
    env.DB,
    outboundAudience(JSON.stringify(tombstone), identity.domain).actorUris,
  );
  const sent = new Set([
    ...followers.unwrapOr([]),
    ...[...(addressed.isOk() ? addressed.value.values() : [])].map(RemoteActor.deliveryInbox),
  ]);
  const toFollowers = reachesRemoteInboxes(tombstone, identity.domain);
  const beyond = reach.map((inboxes) => inboxes.filter((inbox) => !sent.has(inbox)));
  if (!toFollowers && beyond.isOk() && beyond.value.length === 0) {
    return ok(true);
  }
  // Signed once for both, as Mastodon signs the payload it delivers to all.
  const signed = await deliveredActivity(env, account, tombstone);
  if (toFollowers) {
    // The status is gone either way; a failed enqueue only leaves remote copies.
    const enqueued = await enqueueLocalActivity(env, account, "Delete", signed);
    if (enqueued.isErr()) {
      console.error(JSON.stringify({ kind: "StatusDeleteNotFederated", statusId: status.id }));
    }
  }
  const enqueued = beyond.isErr()
    ? beyond
    : beyond.value.length === 0
      ? ok(undefined)
      : await enqueueActivityToInboxes(env, account, "Delete", signed, beyond.value);
  if (enqueued.isErr()) {
    console.error(JSON.stringify({ kind: "StatusDeleteReachNotFederated", statusId: status.id }));
  }
  return ok(true);
};
