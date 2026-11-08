import type { ApiPollJSON } from "@tstodon/api";
import type { RemoteEmoji, RemotePollValue } from "@tstodon/domain";
import { remoteEmojisJson, remoteEmojisInTexts } from "./remote-emoji-document";
import type { PollRecord } from "./poll-store";
import { NO_REMOTE_POLL_VOTES, type RemotePollVotes } from "./remote-poll-vote-store";

export const pollJson = (poll: PollRecord): ApiPollJSON => {
  const expired = Date.parse(poll.expiresAt) <= Date.now();
  // A poll that hides totals keeps each option's count secret until it ends,
  // as Mastodon's: the total votes and voters stay shown.
  const hidden = poll.hideTotals && !expired;
  return {
    id: poll.id,
    expires_at: poll.expiresAt,
    expired,
    multiple: poll.multiple,
    votes_count: poll.options.reduce((sum, option) => sum + option.votesCount, 0),
    voters_count: poll.votersCount,
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

/**
 * The Poll entity of a cached remote poll. Votes cast from this server are
 * added to the author's counts until the author reports a fresh tally.
 */
export const remotePollJson = (
  statusId: string,
  poll: Exclude<RemotePollValue, { kind: "NoPoll" }>,
  votes: RemotePollVotes = NO_REMOTE_POLL_VOTES,
  emojis: ReadonlyArray<RemoteEmoji> = [],
): ApiPollJSON => {
  const expiresAt = poll.ends.kind === "At" ? poll.ends.at : null;
  const options = poll.options.map((option, index) => ({
    title: option.title,
    votes_count: option.votesCount + (votes.pendingByChoice.get(index) ?? 0),
  }));
  const votesCount = options.reduce((sum, option) => sum + option.votes_count, 0);
  return {
    id: remotePollId(statusId),
    expires_at: expiresAt,
    expired: expiresAt !== null && Date.parse(expiresAt) <= Date.now(),
    multiple: poll.kind === "MultipleChoicePoll",
    votes_count: votesCount,
    // Without a reported total, one vote per voter makes the vote total the voter total.
    voters_count:
      poll.voters.kind === "Reported"
        ? poll.voters.count + votes.pendingVoters
        : poll.kind === "SingleChoicePoll"
          ? votesCount
          : null,
    voted: votes.ownChoices.length > 0,
    own_votes: [...votes.ownChoices],
    options,
    // Only the emoji the option titles use belong to the poll.
    emojis: remoteEmojisJson(
      remoteEmojisInTexts(
        poll.options.map((option) => option.title),
        emojis,
      ),
    ),
  };
};
