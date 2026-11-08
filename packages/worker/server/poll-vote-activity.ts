import { InstanceIdentity, type LocalAccount } from "@tstodon/domain";

/**
 * The `Create` that casts one vote on a remote poll, as Mastodon sends it:
 * a `Note` named after the chosen option, replying to the `Question` and
 * addressed to the poll's author alone. Each choice of a multiple-choice
 * vote is its own activity.
 */
export const pollVoteActivity = (
  identity: InstanceIdentity,
  voter: LocalAccount,
  vote: Readonly<{
    id: string;
    optionTitle: string;
    questionUri: string;
    authorUri: string;
    publishedAt: string;
  }>,
): Record<string, unknown> => {
  const actor = InstanceIdentity.actorUrl(identity, voter.username);
  const noteId = pollVoteNoteId(identity, voter, vote.id);
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${noteId}/activity`,
    type: "Create",
    actor,
    published: vote.publishedAt,
    to: [vote.authorUri],
    object: {
      id: noteId,
      type: "Note",
      attributedTo: actor,
      name: vote.optionTitle,
      inReplyTo: vote.questionUri,
      published: vote.publishedAt,
      to: [vote.authorUri],
    },
  };
};

/** The URI of a vote's `Note`, under the voter's statuses path where Mastodon puts it. */
export const pollVoteNoteId = (
  identity: InstanceIdentity,
  voter: LocalAccount,
  voteId: string,
): string => `${InstanceIdentity.actorUrl(identity, voter.username)}/statuses/${voteId}`;
