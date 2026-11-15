import type { Context } from "hono";
import { assertNever, warmSchemas } from "@tstodon/core";
import { PollBallot } from "@tstodon/domain";
import { jsonAuthError, jsonRepositoryError, jsonValidationError, requireUser } from "../http";
import { pollJson, remotePollJson, statusIdOfRemotePoll } from "../poll-document";
import { findRemotePollVotes } from "../remote-poll-vote-store";
import { voteOnRemotePoll } from "../remote-poll-own-vote";
import { findRemoteStatusById } from "../remote-status-store";
import { canViewRemoteStatus } from "../visibility-guard";
import { findPollById, votePoll } from "../poll-store";
import { schedulePollUpdate } from "../poll-update";
import { numberList } from "../form-values";
import { ApiPollVoteParamsSchema } from "@tstodon/api";
import { readParams } from "../request-params";

/**
 * What a refused ballot on a remote poll answers. The rules Mastodon's
 * `VoteValidator` has answer in its words (`PollBallot.message`): it refuses
 * a second choice on a single-choice poll as a vote already cast.
 */
const REMOTE_VOTE_REFUSALS = {
  DomainBlocked: "The poll's server is blocked",
  AlreadyVoted: PollBallot.message(["AlreadyVoted"]),
  Expired: PollBallot.message(["Expired"]),
  NoChoice: "Choose at least one option",
  TooManyChoices: PollBallot.message(["AlreadyVoted"]),
  OutOfRange: PollBallot.message(["InvalidChoice"]),
} as const;

export const getV1PollsById = async (c: Context<{ Bindings: Env }, "/api/v1/polls/:id">) => {
  const user = await requireUser(c);
  const viewerId = user.isOk() ? user.value.id : undefined;
  if (user.isErr() && user.error.kind !== "MissingToken") {
    return jsonAuthError(c, user.error);
  }
  const remoteStatusId = statusIdOfRemotePoll(c.req.param("id"));
  if (remoteStatusId !== undefined) {
    const remote = await findRemoteStatusById(c.env.DB, remoteStatusId);
    if (remote.isErr()) {
      return jsonRepositoryError(c, remote.error.message);
    }
    if (
      !remote.value ||
      remote.value.poll.kind === "NoPoll" ||
      !(await canViewRemoteStatus(c.env.DB, remote.value, viewerId))
    ) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    const votes = await findRemotePollVotes(c.env.DB, viewerId, [remote.value]);
    return c.json(
      remotePollJson(
        remote.value.id,
        remote.value.poll,
        votes.get(remote.value.id),
        remote.value.emojis,
      ),
    );
  }
  const poll = await findPollById(c.env.DB, c.req.param("id"), viewerId);
  if (poll.isErr()) {
    return jsonRepositoryError(c, poll.error.message);
  }
  if (!poll.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(pollJson(poll.value));
};

export const postV1PollsByIdVotes = async (
  c: Context<{ Bindings: Env }, "/api/v1/polls/:id/votes">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readParams(c, ApiPollVoteParamsSchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const indexes = numberList(body.value.choices);
  const remoteStatusId = statusIdOfRemotePoll(c.req.param("id"));
  if (remoteStatusId !== undefined) {
    const voted = await voteOnRemotePoll(c.env, user.value, remoteStatusId, indexes);
    if (voted.isOk()) {
      return c.json(voted.value);
    }
    const failure = voted.error;
    if (failure.kind === "Failed") {
      return jsonRepositoryError(c, failure.message);
    }
    return failure.kind === "NotFound"
      ? c.json({ error: "Record not found", kind: "NotFound" }, 404)
      : c.json({ error: REMOTE_VOTE_REFUSALS[failure.kind], kind: failure.kind }, 422);
  }
  const voted = await votePoll(c.env.DB, c.req.param("id"), user.value.id, indexes);
  if (voted.isErr()) {
    const failure = voted.error;
    switch (failure.kind) {
      case "RepositoryError":
        return jsonRepositoryError(c, failure.message);
      case "PollNotFound":
        return c.json({ error: "Record not found", kind: "NotFound" }, 404);
      case "VoteInvalid":
        return c.json({ error: PollBallot.message(failure.errors), kind: "ValidationError" }, 422);
      default:
        return assertNever(failure);
    }
  }
  const poll = await findPollById(c.env.DB, c.req.param("id"), user.value.id);
  if (poll.isErr() || !poll.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  await schedulePollUpdate(c.env, poll.value);
  // Mastodon answers a vote with the updated Poll entity, not the status.
  return c.json(pollJson(poll.value));
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([ApiPollVoteParamsSchema]);
