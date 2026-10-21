import { warmSchemas } from "@tstodon/core";
import { Hono } from "hono";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readBody,
  requireUser,
} from "../http";
import { pollJson } from "../poll-document";
import { findPollById, votePoll } from "../poll-store";
import { numberList } from "../form-values";
import { z } from "zod";

export const PollVoteBodySchema = z.object({
  choices: z.union([z.array(z.union([z.number(), z.string()])), z.number(), z.string()]),
});

export const pollRoutes = new Hono<{ Bindings: Env }>();

pollRoutes.get("/api/v1/polls/:id", async (c) => {
  const user = await requireUser(c);
  const viewerId = user.isOk() ? user.value.id : undefined;
  if (user.isErr() && user.error.kind !== "MissingToken") {
    return jsonAuthError(c, user.error);
  }
  const poll = await findPollById(c.env.DB, c.req.param("id"), viewerId);
  if (poll.isErr()) {
    return jsonRepositoryError(c, poll.error.message);
  }
  if (!poll.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(pollJson(poll.value));
});

pollRoutes.post("/api/v1/polls/:id/votes", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readBody(c, PollVoteBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const indexes = numberList(body.value.choices);
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
  // Mastodon answers a vote with the updated Poll entity, not the status.
  return c.json(pollJson(poll.value));
});

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([PollVoteBodySchema]);
