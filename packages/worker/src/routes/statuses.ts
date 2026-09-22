import {
  InstanceIdentity,
  LocalStatus,
  StatusComposition,
  StatusId,
  Visibility,
  type StatusIdValue,
} from "@tstodon/domain";
import { Hono } from "hono";
import { findAccountByUsername } from "../account-store";
import { authenticate } from "../auth";
import { noteDocument } from "../activitypub";
import { nowInstant } from "../clock";
import { enqueueLocalActivity } from "../delivery";
import { mentionUsernames, textToHtml } from "../html";
import { replaceStatusMentions } from "../mention-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryLimit,
  readBody,
  requireUser,
} from "../http";
import { newEntityId } from "../ids";
import {
  mastodonRemoteStatus,
  mastodonStatus,
  mastodonStatuses,
  remoteStatusVisible,
} from "../mastodon";
import { insertPoll } from "../poll-store";
import { CreateStatusBodySchema, isTruthy, stringList } from "../schemas";
import { parseInstanceIdentity } from "../runtime-config";
import { findRemoteActorByUri } from "../remote-actor-store";
import { findRemoteStatusById } from "../remote-status-store";
import {
  bookmarkStatus,
  favouriteStatus,
  unbookmarkStatus,
  unfavouriteStatus,
} from "../social-store";
import { notifyAccount } from "../notify";
import { publishToAccount } from "../stream-publish";
import {
  deleteReblogOf,
  deleteStatus,
  findStatusById,
  insertLocalNote,
  insertLocalReblog,
  listBookmarkedStatuses,
  listFavouritedStatuses,
  listStatusAncestors,
  listStatusDescendants,
} from "../status-store";
import { canViewStatus } from "../visibility-guard";

export const statusRoutes = new Hono<{ Bindings: Env }>();

statusRoutes.post("/api/v1/statuses", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readBody(c, CreateStatusBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const visibilityRaw =
    body.value.visibility && body.value.visibility.length > 0
      ? body.value.visibility
      : Visibility.toMastodon(user.value.defaultPostVisibility);
  const visibility = Visibility.fromMastodon(visibilityRaw);
  if (visibility.isErr()) {
    return c.json({ error: "Invalid visibility", kind: "Unknown" }, 400);
  }
  const pollRaw = body.value.poll;
  const pollOptions = pollRaw ? [...pollRaw.options] : [];
  const composing = StatusComposition.composing({
    text: body.value.status ?? "",
    visibility: visibility.value,
    spoilerText: body.value.spoiler_text ?? "",
    sensitive: isTruthy(body.value.sensitive),
    language:
      body.value.language && body.value.language.length > 0
        ? { kind: "Present", value: body.value.language }
        : { kind: "None" },
    mediaIds: stringList(body.value.media_ids),
    poll: pollOptions.length >= 2 ? { kind: "Present" } : { kind: "None" },
  });
  const draft = StatusComposition.validate(composing);
  if (draft.isErr()) {
    return c.json({ error: draft.error.kind, kind: draft.error.kind }, 422);
  }
  let inReplyToId: StatusIdValue | null = null;
  const replyRaw = body.value.in_reply_to_id?.trim() ?? "";
  if (replyRaw.length > 0) {
    const replyId = StatusId.parse(replyRaw);
    if (replyId.isErr()) {
      return c.json({ error: "Invalid in_reply_to_id", kind: "ValidationError" }, 422);
    }
    const parent = await findStatusById(c.env.DB, replyId.value);
    if (parent.isErr()) {
      return jsonRepositoryError(c, parent.error.message);
    }
    if (!parent.value) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    if (!(await canViewStatus(c.env.DB, parent.value, user.value.id))) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    inReplyToId = replyId.value;
  }
  const id = StatusId.parse(newEntityId());
  if (id.isErr()) {
    return jsonRepositoryError(c, "invalid status id");
  }
  const note = LocalStatus.publish(
    id.value,
    user.value.id,
    draft.value,
    nowInstant(),
    textToHtml(draft.value.text),
    inReplyToId,
  );
  const inserted = await insertLocalNote(c.env.DB, note);
  if (inserted.isErr()) {
    return jsonRepositoryError(c, inserted.error.message);
  }
  if (pollOptions.length >= 2) {
    const expiresIn = Number(pollRaw?.expires_in ?? 86400);
    const expiresAt = new Date(
      Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 86400) * 1000,
    ).toISOString();
    const poll = await insertPoll(c.env.DB, {
      statusId: note.id,
      multiple: isTruthy(pollRaw?.multiple),
      expiresAt,
      options: pollOptions,
    });
    if (poll.isErr()) {
      return jsonRepositoryError(c, poll.error.message);
    }
  }
  const mentionedAccountIds: string[] = [];
  for (const username of mentionUsernames(note.text)) {
    const mentioned = await findAccountByUsername(c.env.DB, username);
    if (mentioned.isOk() && mentioned.value) {
      mentionedAccountIds.push(mentioned.value.id);
      if (mentioned.value.id !== user.value.id) {
        await notifyAccount(c.env, {
          accountId: mentioned.value.id,
          fromAccountId: user.value.id,
          kind: "mention",
          statusId: note.id,
        });
      }
    }
  }
  const mentionsSaved = await replaceStatusMentions(c.env.DB, note.id, mentionedAccountIds);
  if (mentionsSaved.isErr()) {
    return jsonRepositoryError(c, mentionsSaved.error.message);
  }
  const actor = InstanceIdentity.actorUrl(identity.value, user.value.username);
  await enqueueLocalActivity(c.env, user.value.id, "Create", {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${actor}/statuses/${note.id}/activity`,
    type: "Create",
    actor,
    object: noteDocument(identity.value, user.value, note),
  });
  const document = await mastodonStatus(c.env, identity.value, note, user.value.id);
  await publishToAccount(c.env, user.value.id, {
    kind: "update",
    payload: document,
  });
  return c.json(document, 200);
});

statusRoutes.get("/api/v1/statuses/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const status = await findStatusById(c.env.DB, c.req.param("id"));
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  if (!status.value) {
    const remote = await findRemoteStatusById(c.env.DB, c.req.param("id"));
    if (remote.isErr()) {
      return jsonRepositoryError(c, remote.error.message);
    }
    if (!remote.value || !remoteStatusVisible(remote.value)) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    const actor = await findRemoteActorByUri(c.env.DB, remote.value.actorUri);
    if (actor.isErr()) {
      return jsonRepositoryError(c, actor.error.message);
    }
    if (!actor.value) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    return c.json(mastodonRemoteStatus(identity.value, remote.value, actor.value));
  }
  const visible = await canViewStatus(c.env.DB, status.value, viewerId);
  if (!visible) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const document = await mastodonStatus(c.env, identity.value, status.value, viewerId);
  if (!document) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(document);
});

statusRoutes.delete("/api/v1/statuses/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const existing = await findStatusById(c.env.DB, c.req.param("id"));
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  if (!existing.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const document = await mastodonStatus(c.env, identity.value, existing.value, user.value.id);
  const deleted = await deleteStatus(c.env.DB, c.req.param("id"), user.value.id);
  if (deleted.isErr()) {
    return jsonRepositoryError(c, deleted.error.message);
  }
  if (!deleted.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(document ?? {});
});

statusRoutes.get("/api/v1/statuses/:id/context", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const status = await findStatusById(c.env.DB, c.req.param("id"));
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  if (!status.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (!(await canViewStatus(c.env.DB, status.value, viewerId))) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const ancestors = await listStatusAncestors(c.env.DB, status.value.id);
  if (ancestors.isErr()) {
    return jsonRepositoryError(c, ancestors.error.message);
  }
  const descendants = await listStatusDescendants(c.env.DB, status.value.id);
  if (descendants.isErr()) {
    return jsonRepositoryError(c, descendants.error.message);
  }
  const visibleAncestors = [];
  for (const candidate of ancestors.value) {
    if (await canViewStatus(c.env.DB, candidate, viewerId)) {
      visibleAncestors.push(candidate);
    }
  }
  const visibleDescendants = [];
  for (const candidate of descendants.value) {
    if (await canViewStatus(c.env.DB, candidate, viewerId)) {
      visibleDescendants.push(candidate);
    }
  }
  return c.json({
    ancestors: await mastodonStatuses(c.env, identity.value, visibleAncestors, viewerId),
    descendants: await mastodonStatuses(c.env, identity.value, visibleDescendants, viewerId),
  });
});

statusRoutes.post("/api/v1/statuses/:id/favourite", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const status = await findStatusById(c.env.DB, c.req.param("id"));
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  if (!status.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const created = await favouriteStatus(c.env.DB, user.value.id, status.value.id);
  if (created.isOk() && created.value && status.value.accountId !== user.value.id) {
    await notifyAccount(c.env, {
      accountId: status.value.accountId,
      fromAccountId: user.value.id,
      kind: "favourite",
      statusId: status.value.id,
    });
  }
  const latest = await findStatusById(c.env.DB, status.value.id);
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
});

statusRoutes.post("/api/v1/statuses/:id/unfavourite", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  await unfavouriteStatus(c.env.DB, user.value.id, c.req.param("id"));
  const latest = await findStatusById(c.env.DB, c.req.param("id"));
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
});

statusRoutes.post("/api/v1/statuses/:id/reblog", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const status = await findStatusById(c.env.DB, c.req.param("id"));
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  if (!status.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const reblogId = StatusId.parse(newEntityId());
  if (reblogId.isErr()) {
    return jsonRepositoryError(c, "invalid status id");
  }
  const reblog = LocalStatus.reblog(reblogId.value, user.value.id, status.value.id, nowInstant());
  const inserted = await insertLocalReblog(c.env.DB, reblog);
  if (inserted.isErr()) {
    return jsonRepositoryError(c, inserted.error.message);
  }
  if (status.value.accountId !== user.value.id) {
    await notifyAccount(c.env, {
      accountId: status.value.accountId,
      fromAccountId: user.value.id,
      kind: "reblog",
      statusId: status.value.id,
    });
  }
  const actor = InstanceIdentity.actorUrl(identity.value, user.value.username);
  await enqueueLocalActivity(c.env, user.value.id, "Announce", {
    type: "Announce",
    actor,
    object: `${actor}/statuses/${status.value.id}`,
  });
  const latest = await findStatusById(c.env.DB, status.value.id);
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
});

statusRoutes.post("/api/v1/statuses/:id/unreblog", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  await deleteReblogOf(c.env.DB, user.value.id, c.req.param("id"));
  const latest = await findStatusById(c.env.DB, c.req.param("id"));
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
});

statusRoutes.post("/api/v1/statuses/:id/bookmark", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  await bookmarkStatus(c.env.DB, user.value.id, c.req.param("id"));
  const latest = await findStatusById(c.env.DB, c.req.param("id"));
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
});

statusRoutes.post("/api/v1/statuses/:id/unbookmark", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  await unbookmarkStatus(c.env.DB, user.value.id, c.req.param("id"));
  const latest = await findStatusById(c.env.DB, c.req.param("id"));
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
});

statusRoutes.get("/api/v1/favourites", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const statuses = await listFavouritedStatuses(
    c.env.DB,
    user.value.id,
    queryLimit(c.req.query("limit")),
  );
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  return c.json(await mastodonStatuses(c.env, identity.value, statuses.value, user.value.id));
});

statusRoutes.get("/api/v1/bookmarks", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const statuses = await listBookmarkedStatuses(
    c.env.DB,
    user.value.id,
    queryLimit(c.req.query("limit")),
  );
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  return c.json(await mastodonStatuses(c.env, identity.value, statuses.value, user.value.id));
});
