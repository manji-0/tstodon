import { type LocalAccount, RemotePoll, type RemotePollChoiceError } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { suspendedDomains } from "./admin-domain-block-store";
import { nowIso } from "./clock";
import { enqueueTargetedActivity } from "./delivery";
import { hostnameOf, isDomainBlocked } from "./domain-block-store";
import { newEntityId } from "./ids";
import { pollVoteActivity } from "./poll-vote-activity";
import { remotePollJson } from "./poll-document";
import { findRemoteActorByUri } from "./remote-actor-store";
import { findRemotePollVotes, recordRemotePollVotes } from "./remote-poll-vote-store";
import { findRemoteStatusById } from "./remote-status-store";
import { federatesWithHost, parseInstanceIdentity } from "./runtime-config";
import { canViewRemoteStatus } from "./visibility-guard";

export type RemotePollVoteError =
  | RemotePollChoiceError
  | Readonly<{ kind: "NotFound" | "DomainBlocked" | "AlreadyVoted" }>
  | Readonly<{ kind: "Failed"; message: string }>;

/**
 * Cast the voter's choices on a cached remote poll: store them, show them
 * in the counts straight away, and federate one `Create` per choice to the
 * poll author's inbox. Answers with the updated Poll entity.
 */
export const voteOnRemotePoll = async (
  env: Env,
  voter: LocalAccount,
  statusId: string,
  requested: ReadonlyArray<number>,
): Promise<Result<Record<string, unknown>, RemotePollVoteError>> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return err({ kind: "Failed", message: "invalid instance configuration" });
  }
  const found = await findRemoteStatusById(env.DB, statusId);
  if (found.isErr()) {
    return err({ kind: "Failed", message: found.error.message });
  }
  const status = found.value;
  if (
    !status ||
    status.poll.kind === "NoPoll" ||
    !(await canViewRemoteStatus(env.DB, status, voter.id))
  ) {
    return err({ kind: "NotFound" });
  }
  const poll = status.poll;
  const author = await findRemoteActorByUri(env.DB, status.actorUri);
  if (author.isErr()) {
    return err({ kind: "Failed", message: author.error.message });
  }
  if (!author.value) {
    return err({ kind: "NotFound" });
  }
  const inboxHost = hostnameOf(author.value.inboxUri) ?? author.value.domain.toLowerCase();
  const blocked = await isDomainBlocked(env.DB, voter.id, author.value.domain.toLowerCase());
  if (
    blocked.isErr() ||
    blocked.value ||
    (await suspendedDomains(env.DB)).has(inboxHost) ||
    !(await federatesWithHost(env, inboxHost))
  ) {
    return err({ kind: "DomainBlocked" });
  }
  const existing = await findRemotePollVotes(env.DB, voter.id, [status]);
  if ((existing.get(status.id)?.ownChoices.length ?? 0) > 0) {
    return err({ kind: "AlreadyVoted" });
  }
  const choices = RemotePoll.selectChoices(poll, requested, Date.now());
  if (choices.isErr()) {
    return err(choices.error);
  }
  const publishedAt = nowIso();
  const votes = choices.value.map((choice) => {
    const id = newEntityId();
    return {
      choice,
      activity: pollVoteActivity(identity.value, voter, {
        id,
        optionTitle: poll.options[choice]?.title ?? "",
        questionUri: status.objectUri,
        authorUri: status.actorUri,
        publishedAt,
      }),
    };
  });
  const recorded = await recordRemotePollVotes(
    env.DB,
    status.id,
    voter.id,
    votes.map((vote) => ({ choice: vote.choice, activityId: String(vote.activity.id) })),
  );
  if (recorded.isErr()) {
    return err({ kind: "Failed", message: recorded.error.message });
  }
  for (const vote of votes) {
    if (!recorded.value.includes(vote.choice)) {
      continue;
    }
    const enqueued = await enqueueTargetedActivity(
      env,
      voter.id,
      "Create",
      vote.activity,
      author.value.inboxUri,
    );
    if (enqueued.isErr()) {
      return err({
        kind: "Failed",
        message: "message" in enqueued.error ? enqueued.error.message : enqueued.error.kind,
      });
    }
  }
  const after = await findRemotePollVotes(env.DB, voter.id, [status]);
  return ok(remotePollJson(status.id, poll, after.get(status.id), status.emojis));
};
