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
