import type { RemotePollValue } from "@tstodon/domain";
import type { PollRecord } from "./poll-store";

export const pollJson = (poll: PollRecord): Record<string, unknown> => {
  const expired = Date.parse(poll.expiresAt) <= Date.now();
  // A poll that hides totals keeps them secret until it ends.
  const hidden = poll.hideTotals && !expired;
  return {
    id: poll.id,
    expires_at: poll.expiresAt,
    expired,
    multiple: poll.multiple,
    votes_count: hidden ? null : poll.options.reduce((sum, option) => sum + option.votesCount, 0),
    voters_count: hidden || !poll.multiple ? null : poll.votedIndexes.length,
    voted: poll.votedIndexes.length > 0,
    own_votes: [...poll.votedIndexes],
    options: poll.options.map((option) => ({
      title: option.title,
      votes_count: hidden ? null : option.votesCount,
    })),
    emojis: [],
  };
};

const REMOTE_POLL_PREFIX = "remote-";

/** Local poll ids are numeric, so the prefix keeps a remote poll's id apart from them. */
export const remotePollId = (statusId: string): string => `${REMOTE_POLL_PREFIX}${statusId}`;

/** The status id behind a remote poll id, or undefined for a local poll id. */
export const statusIdOfRemotePoll = (pollId: string): string | undefined =>
  pollId.startsWith(REMOTE_POLL_PREFIX) ? pollId.slice(REMOTE_POLL_PREFIX.length) : undefined;

/** The Poll entity of a cached remote poll. Nobody here has voted on it. */
export const remotePollJson = (
  statusId: string,
  poll: Exclude<RemotePollValue, { kind: "NoPoll" }>,
): Record<string, unknown> => {
  const expiresAt = poll.ends.kind === "At" ? poll.ends.at : null;
  const votesCount = poll.options.reduce((sum, option) => sum + option.votesCount, 0);
  return {
    id: remotePollId(statusId),
    expires_at: expiresAt,
    expired: expiresAt !== null && Date.parse(expiresAt) <= Date.now(),
    multiple: poll.kind === "MultipleChoicePoll",
    votes_count: votesCount,
    // Without a reported total, one vote per voter makes the vote total the voter total.
    voters_count:
      poll.voters.kind === "Reported"
        ? poll.voters.count
        : poll.kind === "SingleChoicePoll"
          ? votesCount
          : null,
    voted: false,
    own_votes: [],
    options: poll.options.map((option) => ({
      title: option.title,
      votes_count: option.votesCount,
    })),
    emojis: [],
  };
};
