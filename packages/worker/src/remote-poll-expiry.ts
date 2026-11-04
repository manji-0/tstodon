import { nowIso } from "./clock";
import { notifyFromRemote } from "./notify";
import { claimRemotePollExpiryNotice, listEndedRemotePollVoters } from "./remote-poll-vote-store";
import { findRemoteStatusById } from "./remote-status-store";

/** Voters told per run; the rest wait for the next one. */
const BATCH = 50;

/**
 * Tell local accounts that a remote poll they voted on has ended, with a
 * `poll` notification from the poll's author, as Mastodon does at expiry.
 * Each voter is told once: the claim comes before the notification.
 */
export const notifyEndedRemotePolls = async (env: Env): Promise<void> => {
  const notifiedAt = nowIso();
  const voters = await listEndedRemotePollVoters(env.DB, notifiedAt, BATCH);
  if (voters.isErr()) {
    return;
  }
  for (const voter of voters.value) {
    const claimed = await claimRemotePollExpiryNotice(env.DB, notifiedAt, voter);
    if (claimed.isErr() || !claimed.value) {
      continue;
    }
    const status = await findRemoteStatusById(env.DB, voter.statusId);
    if (status.isErr() || !status.value) {
      continue;
    }
    await notifyFromRemote(env, {
      accountId: voter.accountId,
      actorUri: status.value.actorUri,
      kind: "poll",
      statusId: status.value.id,
    });
  }
};
