/** A rule of Mastodon's `VoteValidator` that a vote breaks. */
export type VoteError = "Expired" | "InvalidChoice" | "SelfVote" | "AlreadyVoted";

/** What the validator needs to know about the poll and its voter. */
export type BallotPoll = Readonly<{
  multiple: boolean;
  optionCount: number;
  expired: boolean;
  /** The voter is the poll's author. */
  ownPoll: boolean;
}>;

/** Mastodon's `polls.errors.*` messages (`config/locales/en.yml`). */
const messages = {
  Expired: "The poll has already ended",
  InvalidChoice: "The chosen vote option does not exist",
  SelfVote: "You cannot vote in your own polls",
  AlreadyVoted: "You have already voted on this poll",
} as const satisfies Record<VoteError, string>;

/** The rules one vote breaks, in the order `VoteValidator#validate` adds them. */
const voteErrors = (
  poll: BallotPoll,
  earlier: ReadonlyArray<number>,
  choice: number,
): ReadonlyArray<VoteError> => [
  ...(poll.expired ? (["Expired"] as const) : []),
  ...(choice < 0 || choice >= poll.optionCount ? (["InvalidChoice"] as const) : []),
  ...(poll.ownPoll ? (["SelfVote"] as const) : []),
  ...((poll.multiple ? earlier.includes(choice) : earlier.length > 0)
    ? (["AlreadyVoted"] as const)
    : []),
];

export const PollBallot = {
  /**
   * The rules a ballot breaks, or none when every choice counts. As
   * Mastodon's `VoteService`, the choices are votes created in order in one
   * transaction: each is checked against the votes before it, and the first
   * refused vote refuses the ballot with its own errors.
   */
  errors: (
    poll: BallotPoll,
    earlier: ReadonlyArray<number>,
    choices: ReadonlyArray<number>,
  ): ReadonlyArray<VoteError> => {
    const cast = [...earlier];
    for (const choice of choices) {
      const errors = voteErrors(poll, cast, choice);
      if (errors.length > 0) {
        return errors;
      }
      cast.push(choice);
    }
    return [];
  },
  /** The `error` Mastodon answers with: `ActiveRecord::RecordInvalid#to_s`. */
  message: (errors: ReadonlyArray<VoteError>): string =>
    `Validation failed: ${errors.map((error) => messages[error]).join(", ")}`,
} as const;
