import type { InstanceIdentity, LocalAccount, LocalStatusValue } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { noteDeleteActivity, noteDocument } from "./activitypub";
import type { RepositoryError } from "./d1";
import { enqueueLocalActivity } from "./delivery";
import { announceRemovedBoosts, enqueueHomeFanOut } from "./home-fan-out";
import { loadNoteMentions } from "./mention-resolve";
import { reachesRemoteInboxes } from "./outbox-job";
import { enqueuePublicFanOut } from "./public-fan-out";
import { loadNoteReply } from "./reply-target";
import { deleteStatus, type StatusMediaOnDelete } from "./status-store";
import { deleteMediaObjects } from "./media-objects";
import { loadNoteQuotePolicy } from "./quote-policy-name";
import { publishToAccount } from "./stream-publish";

/**
 * Delete one of the account's own statuses and tell everyone: the account's
 * streams, the home and public timelines, and the remote servers a `Delete`
 * reaches. `false` means no status of the account had that id. Used by
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
          }),
        )
      : undefined;
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
  await enqueueHomeFanOut(env, {
    event: "delete",
    entryId: status.id,
    author: { kind: "LocalAccount", accountId: account.id },
  });
  if (status.kind === "LocalNote" && status.visibility.kind === "Public") {
    await enqueuePublicFanOut(env, { event: "delete", entryId: status.id });
  }
  if (tombstone && reachesRemoteInboxes(tombstone, identity.domain)) {
    // The status is gone either way; a failed enqueue only leaves remote copies.
    const enqueued = await enqueueLocalActivity(env, account.id, "Delete", tombstone);
    if (enqueued.isErr()) {
      console.error(JSON.stringify({ kind: "StatusDeleteNotFederated", statusId: status.id }));
    }
  }
  return ok(true);
};
