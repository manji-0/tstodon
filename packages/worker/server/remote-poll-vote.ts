import type { InstanceIdentity, LocalNote, RemoteActor } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { parseLocalStatusId } from "./activitypub";
import { PollVoteDocumentSchema } from "./activitypub-wire";
import type { RepositoryError, StoredRowInvalid } from "./d1";
import { listStatusMentions } from "./mention-store";
import { readPollByStatusId, recordRemotePollVote } from "./poll-store";
import { schedulePollUpdate } from "./poll-update";
import { findRemoteFollow } from "./remote-actor-store";
import { readStatusById } from "./status-store";

const parsePollVote = schemaResult(PollVoteDocumentSchema);

/** `NotAVote` leaves the object to the ordinary `Create` handling. */
export type RemotePollVoteResult = Readonly<{
  kind: "NotAVote" | "Ignored" | "Recorded";
}>;

/** Whether the poll's note is open to this remote actor, or addresses them. */
const canVote = async (
  env: Env,
  note: LocalNote,
  actorUri: string,
): Promise<Result<boolean, RepositoryError>> => {
  if (note.visibility.kind === "Public" || note.visibility.kind === "Unlisted") {
    return ok(true);
  }
  const mentions = await listStatusMentions(env.DB, [note.id]);
  if (mentions.isErr()) {
    return err(mentions.error);
  }
  if (mentions.value.get(note.id)?.actorUris.includes(actorUri)) {
    return ok(true);
  }
  if (note.visibility.kind !== "FollowersOnly") {
    return ok(false);
  }
  const follow = await findRemoteFollow(env.DB, note.accountId, actorUri);
  return follow.map((found) => found?.requestKind === "Fulfilled");
};

/**
 * The answer to a vote whose poll could not be read. A row that does not
 * read as the poll's status or as the poll drops the vote, logged: sent
 * again, the vote would find the same row. A failed read is an error.
 */
const unreadPoll = (
  error: RepositoryError | StoredRowInvalid,
): Result<RemotePollVoteResult, RepositoryError> => {
  if (error.kind === "RepositoryError") {
    return err(error);
  }
  console.warn(JSON.stringify({ kind: "PollVoteDroppedForInvalidRow", rowId: error.id }));
  return ok({ kind: "Ignored" });
};

/**
 * Count the vote a remote `Create` casts on a local poll. A vote is a `Note`
 * named for the option it picks, replying to the poll's note, with no content.
 * It is never stored as a status and never notifies as a mention. An `Err` is
 * a storage failure, which the sender answers by delivering the vote again: it
 * is then counted, or found counted, and its poll update queued either way.
 */
export const handleRemotePollVote = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  object: string | Readonly<{ id: string } & Record<string, unknown>>,
): Promise<Result<RemotePollVoteResult, RepositoryError>> => {
  const vote = typeof object === "string" ? undefined : parsePollVote(object);
  if (
    !vote ||
    vote.isErr() ||
    (vote.value.content ?? "").trim().length > 0 ||
    vote.value.attributedTo !== actor.actorUri
  ) {
    return ok({ kind: "NotAVote" });
  }
  const statusId = parseLocalStatusId(identity, vote.value.inReplyTo);
  if (!statusId) {
    return ok({ kind: "NotAVote" });
  }
  const status = await readStatusById(env.DB, statusId);
  if (status.isErr()) {
    return unreadPoll(status.error);
  }
  if (status.value?.kind !== "LocalNote") {
    return ok({ kind: "NotAVote" });
  }
  const note = status.value;
  const poll = await readPollByStatusId(env.DB, note.id, undefined);
  if (poll.isErr()) {
    return unreadPoll(poll.error);
  }
  if (!poll.value) {
    return ok({ kind: "NotAVote" });
  }
  const allowed = await canVote(env, note, actor.actorUri);
  if (allowed.isErr()) {
    return err(allowed.error);
  }
  if (!allowed.value) {
    return ok({ kind: "Ignored" });
  }
  const recorded = await recordRemotePollVote(env.DB, poll.value, {
    actorUri: actor.actorUri,
    objectUri: vote.value.id,
    title: vote.value.name,
  });
  if (recorded.isErr()) {
    return err(recorded.error);
  }
  if (recorded.value.kind !== "Recorded" && recorded.value.kind !== "Undistributed") {
    return ok({ kind: "Ignored" });
  }
  // `Undistributed` is the redelivery of a vote that was counted before a
  // failure below: it queues the update the first delivery did not. A vote
  // sent again after its update went out is a `Duplicate` and queues none,
  // so new activity ids for one vote cannot make the poll federate again.
  const counted = await readPollByStatusId(env.DB, note.id, undefined);
  if (counted.isErr()) {
    return unreadPoll(counted.error);
  }
  if (counted.value) {
    await schedulePollUpdate(env, counted.value);
  }
  return ok({ kind: recorded.value.kind === "Recorded" ? "Recorded" : "Ignored" });
};
