import { InstanceIdentity, type LocalNote, type OutboxJob } from "@tstodon/domain";
import { findAccountById } from "./account-store";
import { noteDocument } from "./activitypub";
import { nowIso } from "./clock";
import { enqueueLocalActivity } from "./delivery";
import { newEntityId } from "./ids";
import { loadNoteMentions } from "./mention-resolve";
import { reachesRemoteInboxes } from "./outbox-job";
import { claimPollUpdate, findPollById, type PollRecord, releasePollUpdate } from "./poll-store";
import { quotedStatusUri } from "./quote-uri";
import { loadNoteReply } from "./reply-target";
import { parseInstanceIdentity } from "./runtime-config";
import { findStatusById } from "./status-store";

/** Mastodon's `DistributePollUpdateWorker` waits this long, so votes in between share one `Update`. */
export const POLL_UPDATE_DELAY_SECONDS = 180;

/**
 * Queue the `Update(Question)` that tells a poll's audience the new counts,
 * unless one is already queued. The job reads the counts when it runs, so
 * every vote cast before then is in it. A poll that hides its totals has
 * nothing to tell until it ends.
 */
export const schedulePollUpdate = async (env: Env, poll: PollRecord): Promise<void> => {
  if (poll.hideTotals) {
    return;
  }
  const claimed = await claimPollUpdate(env.DB, poll.id);
  if (claimed.isErr() || !claimed.value) {
    return;
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(
      { kind: "DistributePollUpdate", pollId: poll.id },
      { delaySeconds: POLL_UPDATE_DELAY_SECONDS },
    );
  } catch {
    await releasePollUpdate(env.DB, poll.id);
    console.error(JSON.stringify({ kind: "PollUpdateNotQueued", pollId: poll.id }));
  }
};

const distributePollUpdate = async (
  env: Env,
  identity: InstanceIdentity,
  note: LocalNote,
  poll: PollRecord,
): Promise<void> => {
  const author = await findAccountById(env.DB, note.accountId);
  if (author.isErr() || !author.value) {
    return;
  }
  const actor = InstanceIdentity.actorUrl(identity, author.value.username);
  const update = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${actor}/statuses/${note.id}/updates/${newEntityId()}`,
    type: "Update",
    actor,
    published: nowIso(),
    object: noteDocument(identity, author.value, note, {
      quoteUri: await quotedStatusUri(env, identity, note.id),
      mentions: await loadNoteMentions(env.DB, identity, note.id),
      reply: await loadNoteReply(env.DB, identity, note),
      poll,
    }),
  };
  if (!reachesRemoteInboxes(update, identity.domain)) {
    return;
  }
  const enqueued = await enqueueLocalActivity(env, author.value.id, "Update", update);
  if (enqueued.isErr()) {
    console.error(JSON.stringify({ kind: "PollUpdateNotFederated", statusId: note.id }));
  }
};

/**
 * Queue handler: federate the poll's current counts. The slot is freed first,
 * so a vote that lands while this runs queues the next job.
 */
export const processDistributePollUpdateJob = async (
  env: Env,
  job: Extract<OutboxJob, { kind: "DistributePollUpdate" }>,
): Promise<"ok"> => {
  await releasePollUpdate(env.DB, job.pollId);
  const identity = parseInstanceIdentity(env);
  const found = await findPollById(env.DB, job.pollId, undefined);
  if (identity.isErr() || found.isErr() || !found.value || found.value.hideTotals) {
    return "ok";
  }
  const status = await findStatusById(env.DB, found.value.statusId);
  if (status.isOk() && status.value?.kind === "LocalNote") {
    await distributePollUpdate(env, identity.value, status.value, found.value);
  }
  return "ok";
};
