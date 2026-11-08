import type { Context } from "hono";
import { warmSchemas } from "@tstodon/core";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readBody,
  requireUser,
} from "../http";
import { pollJson, remotePollJson, statusIdOfRemotePoll } from "../poll-document";
import { findRemotePollVotes } from "../remote-poll-vote-store";
import { voteOnRemotePoll } from "../remote-poll-own-vote";
import { findRemoteStatusById } from "../remote-status-store";
import { canViewRemoteStatus } from "../visibility-guard";
import { findPollById, votePoll } from "../poll-store";
import { schedulePollUpdate } from "../poll-update";
import { numberList } from "../form-values";
import { z } from "zod";

export const PollVoteBodySchema = z.object({
  choices: z.union([z.array(z.union([z.number(), z.string()])), z.number(), z.string()]),
});

const REMOTE_VOTE_REFUSALS = {
  DomainBlocked: "The poll's server is blocked",
  AlreadyVoted: "You have already voted on this poll",
  Expired: "The poll has ended",
  NoChoice: "Choose at least one option",
  TooManyChoices: "This poll takes a single choice",
  OutOfRange: "That option does not exist",
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
  const body = await readBody(c, PollVoteBodySchema);
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
    if (voted.error.message === "poll expired") {
      return c.json({ error: "poll expired", kind: "PollExpired" }, 422);
    }
    return jsonRepositoryError(c, voted.error.message);
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
warmSchemas([PollVoteBodySchema]);
