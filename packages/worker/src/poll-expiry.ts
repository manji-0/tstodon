import { assertNever } from "@tstodon/core";
import type { LocalStatus } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import { documentsById } from "./documents-by-id";
import { mastodonStatuses } from "./local-status-documents";
import { notifyFromLocal, notifyFromRemote } from "./notify";
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

/** Polls, and separately voters, handled per run; the rest wait for the next one. */
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
      return notifyFromLocal(env, {
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
 * Tell local accounts that a poll they voted on has ended, local or remote.
 * Remote voters of a local poll hear it from their own servers. Each voter is
 * told once: the claim comes before the notification, so a redelivered job
 * finds nobody left to tell.
 */
const notifyEndedPollVoters = async (env: Env, notifiedAt: string): Promise<void> => {
  const [remote, local] = await Promise.all([
    listEndedRemotePollVoters(env.DB, notifiedAt, BATCH),
    listEndedLocalPollVoters(env.DB, notifiedAt, BATCH),
  ]);
  const voters: ReadonlyArray<EndedPollVoter> = [
    ...(remote.isOk() ? remote.value : []),
    ...(local.isOk() ? local.value : []),
  ];
  for (const voter of voters) {
    const claimed = await claimNotice(env, notifiedAt, voter);
    if (claimed.isOk() && claimed.value) {
      await notifyPollEnded(env, voter);
    }
  }
};

/**
 * Announce each local poll that has ended to its author: the status with its
 * final counts on the author's stream, and a `poll` notification from
 * themselves. The claim on the poll comes first, so the author is told once.
 */
const notifyEndedPollAuthors = async (env: Env, notifiedAt: string): Promise<void> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return;
  }
  const expired = await listExpiredUnnotifiedPolls(env.DB, notifiedAt, BATCH);
  if (expired.isErr()) {
    return;
  }
  const claimed: Array<Readonly<{ accountId: string; status: LocalStatus }>> = [];
  for (const poll of expired.value) {
    const marked = await markPollExpiryNotified(env.DB, poll.id, notifiedAt);
    if (marked.isErr() || !marked.value) {
      continue;
    }
    const status = await findStatusById(env.DB, poll.statusId);
    if (status.isOk() && status.value) {
      claimed.push({ accountId: poll.accountId, status: status.value });
    }
  }
  for (const [accountId, items] of Map.groupBy(claimed, (item) => item.accountId)) {
    const statuses = items.map((item) => item.status);
    const byStatusId = documentsById(
      await mastodonStatuses(env, identity.value, statuses, accountId),
    );
    for (const status of statuses) {
      const document = byStatusId.get(status.id);
      if (document) {
        await publishToAccount(env, accountId, { kind: "status.update", payload: document });
      }
      await notifyFromLocal(env, {
        accountId,
        fromAccountId: accountId,
        kind: "poll",
        statusId: status.id,
      });
    }
  }
};

/** The `ProcessExpiredPolls` job, as Mastodon's `PollExpirationNotifyWorker`. */
export const processExpiredPolls = async (env: Env): Promise<void> => {
  const notifiedAt = nowIso();
  await notifyEndedPollVoters(env, notifiedAt);
  await notifyEndedPollAuthors(env, notifiedAt);
};
