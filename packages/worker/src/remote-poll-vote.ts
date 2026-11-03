import type { InstanceIdentity, LocalNote, RemoteActor } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { parseLocalStatusId } from "./activitypub";
import { PollVoteDocumentSchema } from "./activitypub-wire";
import { listStatusMentions } from "./mention-store";
import { loadNotePoll, recordRemotePollVote } from "./poll-store";
import { schedulePollUpdate } from "./poll-update";
import { findRemoteFollow } from "./remote-actor-store";
import { findStatusById } from "./status-store";

const parsePollVote = schemaResult(PollVoteDocumentSchema);

/** `NotAVote` leaves the object to the ordinary `Create` handling. */
export type RemotePollVoteResult = Readonly<{
  kind: "NotAVote" | "Ignored" | "Recorded";
}>;

/** Whether the poll's note is open to this remote actor, or addresses them. */
const canVote = async (env: Env, note: LocalNote, actorUri: string): Promise<boolean> => {
  if (note.visibility.kind === "Public" || note.visibility.kind === "Unlisted") {
    return true;
  }
  const mentions = await listStatusMentions(env.DB, [note.id]);
  if (mentions.isOk() && mentions.value.get(note.id)?.actorUris.includes(actorUri)) {
    return true;
  }
  if (note.visibility.kind !== "FollowersOnly") {
    return false;
  }
  const follow = await findRemoteFollow(env.DB, note.accountId, actorUri);
  return follow.isOk() && follow.value?.requestKind === "Fulfilled";
};

/**
 * Count the vote a remote `Create` casts on a local poll. A vote is a `Note`
 * named for the option it picks, replying to the poll's note, with no content.
 * It is never stored as a status and never notifies as a mention.
 */
export const handleRemotePollVote = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  object: string | Readonly<{ id: string } & Record<string, unknown>>,
): Promise<RemotePollVoteResult> => {
  const vote = typeof object === "string" ? undefined : parsePollVote(object);
  if (
    !vote ||
    vote.isErr() ||
    (vote.value.content ?? "").trim().length > 0 ||
    vote.value.attributedTo !== actor.actorUri
  ) {
    return { kind: "NotAVote" };
  }
  const statusId = parseLocalStatusId(identity, vote.value.inReplyTo);
  const status = statusId ? await findStatusById(env.DB, statusId) : undefined;
  if (!status || status.isErr() || status.value?.kind !== "LocalNote") {
    return { kind: "NotAVote" };
  }
  const note = status.value;
  const poll = await loadNotePoll(env.DB, note.id);
  if (!poll) {
    return { kind: "NotAVote" };
  }
  if (!(await canVote(env, note, actor.actorUri))) {
    return { kind: "Ignored" };
  }
  const recorded = await recordRemotePollVote(env.DB, poll, {
    actorUri: actor.actorUri,
    objectUri: vote.value.id,
    title: vote.value.name,
  });
  if (recorded.isErr() || recorded.value.kind !== "Recorded") {
    return { kind: "Ignored" };
  }
  const counted = await loadNotePoll(env.DB, note.id);
  if (counted) {
    await schedulePollUpdate(env, counted);
  }
  return { kind: "Recorded" };
};
