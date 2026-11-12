import { assertNever } from "@tstodon/core";
import type { LocalStatus } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import { documentsById } from "./documents-by-id";
import { mastodonStatuses } from "./local-status-documents";
import { measureJobPage } from "./metrics";
import { notifyAccount, notifyFromRemote } from "./notify";
import { scheduleFinalPollUpdate } from "./poll-update";
import {
  claimLocalPollExpiryNotice,
  type EndedLocalPollVoter,
  listEndedLocalPollVoters,
  listExpiredUnnotifiedPolls,
  markPollExpiryNotified,
} from "./poll-store";
import {
  claimRemotePollExpiryNotice,
  type EndedRemotePollVoter,
  listEndedRemotePollVoters,
} from "./remote-poll-vote-store";
import { parseInstanceIdentity } from "./runtime-config";
import { findStatusById } from "./status-store";
import { publishToAccount } from "./stream-publish";

/** Polls, and separately voters, handled per run; a full batch queues the next run. */
const BATCH = 50;

/** A local account to tell that a poll it voted on has ended. */
type EndedPollVoter = EndedLocalPollVoter | EndedRemotePollVoter;

const claimNotice = (
  env: Env,
  notifiedAt: string,
  voter: EndedPollVoter,
): Promise<Result<boolean, RepositoryError>> => {
  switch (voter.kind) {
    case "LocalPollVoter":
      return claimLocalPollExpiryNotice(env.DB, notifiedAt, voter);
    case "RemotePollVoter":
      return claimRemotePollExpiryNotice(env.DB, notifiedAt, voter);
    default:
      return assertNever(voter);
  }
};

/** The `poll` notification, from the poll's author, as Mastodon sends it. */
const notifyPollEnded = (
  env: Env,
  voter: EndedPollVoter,
): Promise<Result<void, RepositoryError>> => {
  switch (voter.kind) {
    case "LocalPollVoter":
      return notifyAccount(env, {
        accountId: voter.accountId,
        fromAccountId: voter.authorId,
        kind: "poll",
        statusId: voter.statusId,
      });
    case "RemotePollVoter":
      return notifyFromRemote(env, {
        accountId: voter.accountId,
        actorUri: voter.actorUri,
        kind: "poll",
        statusId: voter.statusId,
      });
    default:
      return assertNever(voter);
  }
};

/**
 * What one pass over a batch did: how many it claimed, and whether the batch
 * was full, so more may be waiting.
 */
type Pass = Readonly<{ claimed: number; full: boolean }>;

const NOTHING: Pass = { claimed: 0, full: false };

/**
 * Tell local accounts that a poll they voted on has ended, local or remote.
 * Remote voters of a local poll hear it from their own servers. Each voter is
 * told once: the claim comes before the notification, so a redelivered job
 * finds nobody left to tell.
 */
const notifyEndedPollVoters = async (env: Env, notifiedAt: string): Promise<Pass> => {
  const [remote, local] = await Promise.all([
    listEndedRemotePollVoters(env.DB, notifiedAt, BATCH),
    listEndedLocalPollVoters(env.DB, notifiedAt, BATCH),
  ]);
  const remoteVoters = remote.isOk() ? remote.value : [];
  const localVoters = local.isOk() ? local.value : [];
  let claimedCount = 0;
  for (const voter of [...remoteVoters, ...localVoters]) {
    const claimed = await claimNotice(env, notifiedAt, voter);
    if (claimed.isOk() && claimed.value) {
      claimedCount += 1;
      await notifyPollEnded(env, voter);
    }
  }
  return {
    claimed: claimedCount,
    full: remoteVoters.length >= BATCH || localVoters.length >= BATCH,
  };
};

/**
 * Announce each local poll that has ended: to its author, the status with its
 * final counts on their stream and a `poll` notification from themselves; to
 * remote servers, an `Update(Question)` with the final counts. The claim on
 * the poll comes first, so each is sent once.
 */
const announceEndedLocalPolls = async (env: Env, notifiedAt: string): Promise<Pass> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return NOTHING;
  }
  const expired = await listExpiredUnnotifiedPolls(env.DB, notifiedAt, BATCH);
  if (expired.isErr()) {
    return NOTHING;
  }
  const claimed: Array<Readonly<{ accountId: string; status: LocalStatus }>> = [];
  let claimedCount = 0;
  for (const poll of expired.value) {
    const marked = await markPollExpiryNotified(env.DB, poll, notifiedAt);
    if (marked.isErr() || !marked.value) {
      continue;
    }
    claimedCount += 1;
    await scheduleFinalPollUpdate(env, poll.id);
    const status = await findStatusById(env.DB, poll.statusId);
    if (status.isOk() && status.value) {
      claimed.push({ accountId: poll.accountId, status: status.value });
    }
  }
  for (const [accountId, items] of Map.groupBy(claimed, (item) => item.accountId)) {
    const statuses = items.map((item) => item.status);
    const rendered = await mastodonStatuses(env, identity.value, statuses, accountId);
    const byStatusId = documentsById(rendered.isOk() ? rendered.value : []);
    for (const status of statuses) {
      const document = byStatusId.get(status.id);
      if (document) {
        await publishToAccount(env, accountId, { kind: "status.update", payload: document });
      }
      await notifyAccount(env, {
        accountId,
        fromAccountId: accountId,
        kind: "poll",
        statusId: status.id,
      });
    }
  }
  return { claimed: claimedCount, full: expired.value.length >= BATCH };
};

/**
 * Whether a `ProcessExpiredPolls` run would find a voter to tell or a poll to
 * announce now, by one row of each list. A failed read answers yes.
 */
export const hasExpiredPollWork = async (env: Env): Promise<boolean> => {
  const now = nowIso();
  const [remote, local, expired] = await Promise.all([
    listEndedRemotePollVoters(env.DB, now, 1),
    listEndedLocalPollVoters(env.DB, now, 1),
    listExpiredUnnotifiedPolls(env.DB, now, 1),
  ]);
  return [remote, local, expired].some((rows) => rows.isErr() || rows.value.length > 0);
};

/**
 * The `ProcessExpiredPolls` job, as Mastodon's `PollExpirationNotifyWorker`.
 * A full batch queues the next run at once rather than waiting for the hourly
 * cron. Only a run that claimed something chains, so a batch that keeps
 * failing waits for the cron instead of looping.
 */
export const processExpiredPolls = (env: Env): Promise<"ok" | "retry"> =>
  measureJobPage(env, "ProcessExpiredPolls", async () => {
    const notifiedAt = nowIso();
    const passes = [
      await notifyEndedPollVoters(env, notifiedAt),
      await announceEndedLocalPolls(env, notifiedAt),
    ];
    const size = passes.reduce((sum, pass) => sum + pass.claimed, 0);
    if (!passes.some((pass) => pass.full && pass.claimed > 0)) {
      return { outcome: "ok", size, chained: false };
    }
    try {
      await env.OUTBOX_PROCESS_QUEUE.send({ kind: "ProcessExpiredPolls" });
    } catch {
      console.error(JSON.stringify({ kind: "ExpiredPollsFollowUpNotQueued" }));
      return { outcome: "ok", size, chained: false };
    }
    return { outcome: "ok", size, chained: true };
  });
