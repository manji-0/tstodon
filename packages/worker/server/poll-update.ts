import { InstanceIdentity, type LocalNote, type OutboxJob } from "@tstodon/domain";
import { findAccountById } from "./account-store";
import { noteDocument } from "./activitypub";
import { nowIso } from "./clock";
import { enqueueLocalActivity } from "./delivery";
import { newEntityId } from "./ids";
import { measureJobPage } from "./metrics";
import { loadNoteMentions } from "./mention-resolve";
import { reachesRemoteInboxes } from "./outbox-job";
import { claimPollUpdate, findPollById, type PollRecord, releasePollUpdate } from "./poll-store";
import { loadNoteQuotePolicy } from "./quote-policy-name";
import { noteQuote } from "./quote-uri";
import { loadNoteMedia } from "./note-attachments";
import { loadNoteReply } from "./reply-target";
import { parseInstanceIdentity } from "./runtime-config";
import { findStatusById } from "./status-store";

/** Mastodon's `DistributePollUpdateWorker` waits this long, so votes in between share one `Update`. */
export const POLL_UPDATE_DELAY_SECONDS = 180;

/**
 * The debounce before a poll's `Update`: the `POLL_UPDATE_DELAY_SECONDS` var
 * when it is a whole number of seconds (local e2e instances shorten it), else 180.
 */
export const pollUpdateDelaySeconds = (
  env: Readonly<{ POLL_UPDATE_DELAY_SECONDS?: string }>,
): number => {
  const raw = (env.POLL_UPDATE_DELAY_SECONDS ?? "").trim();
  return /^\d+$/.test(raw) ? Number(raw) : POLL_UPDATE_DELAY_SECONDS;
};

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
  await queuePollUpdate(env, poll.id, pollUpdateDelaySeconds(env));
};

/**
 * Queue the `Update(Question)` with a poll's final counts, as Mastodon's
 * `PollExpirationNotifyWorker` does once a local poll ends. No debounce: no
 * vote can follow. A job a vote already queued runs after the end and sends
 * the final counts itself.
 */
export const scheduleFinalPollUpdate = (env: Env, pollId: string): Promise<void> =>
  queuePollUpdate(env, pollId, 0);

const queuePollUpdate = async (env: Env, pollId: string, delaySeconds: number): Promise<void> => {
  const claimed = await claimPollUpdate(env.DB, pollId);
  if (claimed.isErr() || !claimed.value) {
    return;
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(
      { kind: "DistributePollUpdate", pollId },
      delaySeconds > 0 ? { delaySeconds } : undefined,
    );
  } catch {
    await releasePollUpdate(env.DB, pollId);
    console.error(JSON.stringify({ kind: "PollUpdateNotQueued", pollId }));
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
  const media = await loadNoteMedia(env.DB, identity, note);
  if (media.isErr()) {
    console.error(JSON.stringify({ kind: "PollUpdateNotFederated", statusId: note.id }));
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
      quote: await noteQuote(env, identity, note.id),
      mentions: await loadNoteMentions(env.DB, identity, note.id),
      reply: await loadNoteReply(env.DB, identity, note),
      poll,
      media: media.value,
      quotePolicy: await loadNoteQuotePolicy(env.DB, author.value, note),
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
 * so a vote that lands while this runs queues the next job. A poll that hides
 * its totals shows them once it has ended, as Mastodon's `show_totals_now?`.
 */
export const processDistributePollUpdateJob = async (
  env: Env,
  job: Extract<OutboxJob, { kind: "DistributePollUpdate" }>,
): Promise<"ok"> => {
  // One poll per job: `size` is 1 when an `Update` was considered, 0 when there was nothing to do.
  await measureJobPage(env, job.kind, async () => {
    await releasePollUpdate(env.DB, job.pollId);
    const identity = parseInstanceIdentity(env);
    const found = await findPollById(env.DB, job.pollId, undefined);
    if (identity.isErr() || found.isErr() || !found.value) {
      return { outcome: "ok", size: 0, chained: false };
    }
    if (found.value.hideTotals && Date.parse(found.value.expiresAt) > Date.now()) {
      return { outcome: "ok", size: 0, chained: false };
    }
    const status = await findStatusById(env.DB, found.value.statusId);
    if (status.isOk() && status.value?.kind === "LocalNote") {
      await distributePollUpdate(env, identity.value, status.value, found.value);
      return { outcome: "ok", size: 1, chained: false };
    }
    return { outcome: "ok", size: 0, chained: false };
  });
  return "ok";
};
