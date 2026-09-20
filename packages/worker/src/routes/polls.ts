import { Hono } from "hono";
import { findStatusById } from "../status-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readBody,
  requireUser,
} from "../http";
import { mastodonStatus, pollJson } from "../mastodon";
import { findPollById, votePoll } from "../poll-store";
import { parseInstanceIdentity } from "../runtime-config";
import { numberList, PollVoteBodySchema } from "../schemas";

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
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
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
    return jsonRepositoryError(c, voted.error.message);
  }
  const poll = await findPollById(c.env.DB, c.req.param("id"), user.value.id);
  if (poll.isErr() || !poll.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const status = await findStatusById(c.env.DB, poll.value.statusId);
  if (status.isOk() && status.value) {
    return c.json(await mastodonStatus(c.env, identity.value, status.value, user.value.id));
  }
  return c.json(pollJson(poll.value));
});
