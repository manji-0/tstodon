import {
  InstanceIdentity,
  LocalStatus,
  StatusComposition,
  StatusId,
  Visibility,
  type StatusIdValue,
} from "@tstodon/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import { findAccountsByUsernames } from "../account-store";
import { authenticate } from "../auth";
import { noteDocument } from "../activitypub";
import { nowInstant, nowIso } from "../clock";
import { enqueueLocalActivity } from "../delivery";
import { mentionUsernames, textToHtml } from "../html";
import { replaceStatusMentions } from "../mention-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryCursor,
  queryLimit,
  readUnknownBody,
  requireUser,
} from "../http";
import { newEntityId } from "../ids";
import {
  mastodonRemoteStatus,
  mastodonStatus,
  mastodonStatuses,
  remoteStatusVisible,
} from "../mastodon";
import { countPollVotes, findPollByStatusId, insertPoll, replacePollOptions } from "../poll-store";
import { CreateStatusBodySchema, isTruthy, mediaAttributesFromForm, stringList } from "../schemas";
import { InstanceLimits, characterCount } from "@tstodon/core";
import { schemaResult } from "@tstodon/core";
import type { MediaAttribute } from "../schemas";
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
  ContextLimits,
  countPinnedStatuses,
  deleteReblogOf,
  deleteStatus,
  findStatusById,
  findStatusUpdatedAt,
  insertLocalNote,
  insertLocalReblog,
  insertStatusEdit,
  isStatusPinned,
  listBookmarkedStatuses,
  listFavouritedStatuses,
  listStatusAncestors,
  listStatusDescendants,
  listStatusEdits,
  pinStatus,
  replaceStatusMedia,
  unpinStatus,
  updateLocalNote,
} from "../status-store";
import { findMediaById, parseMediaFocus, updateMediaMetadata } from "../media-store";
import {
  muteStatusThread,
  resolveThreadRootStatusIds,
  unmuteStatusThread,
} from "../status-mute-store";
import { canViewStatus } from "../visibility-guard";

export const statusRoutes = new Hono<{ Bindings: Env }>();

/** Apply `media_attributes` to media already attached to this status. */
const applyMediaAttributes = async (
  env: Env,
  accountId: string,
  statusId: string,
  attributes: ReadonlyArray<MediaAttribute>,
): Promise<string | undefined> => {
  for (const attribute of attributes) {
    const found = await findMediaById(env.DB, attribute.id);
    if (found.isErr()) {
      return found.error.message;
    }
    const media = found.value;
    if (!media || media.account_id !== accountId || media.status_id !== statusId) {
      continue;
    }
    let focusX = media.focus_x;
    let focusY = media.focus_y;
    if (attribute.focus !== undefined) {
      const focus = parseMediaFocus(attribute.focus);
      if (focus) {
        focusX = focus.x;
        focusY = focus.y;
      }
    }
    if (
      attribute.description !== undefined &&
      characterCount(attribute.description) > InstanceLimits.media.maxDescriptionCharacters
    ) {
      return "media description is too long";
    }
    const description =
      attribute.description === undefined
        ? media.description
        : attribute.description.trim().length > 0
          ? attribute.description
          : null;
    const updated = await updateMediaMetadata(env.DB, {
      id: media.id,
      accountId,
      description,
      focusX,
      focusY,
    });
    if (updated.isErr()) {
      return updated.error.message;
    }
  }
  return undefined;
};

statusRoutes.post("/api/v1/statuses", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const rawBody = await readUnknownBody(c);
  const body = schemaResult(CreateStatusBodySchema)(rawBody).mapErr(() => ({
    kind: "ValidationError" as const,
  }));
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const mediaAttributes = body.value.media_attributes ?? mediaAttributesFromForm(rawBody);
  const visibilityRaw =
    body.value.visibility && body.value.visibility.length > 0
      ? body.value.visibility
      : Visibility.toMastodon(user.value.defaultPostVisibility);
  const visibility = Visibility.fromMastodon(visibilityRaw);
  if (visibility.isErr()) {
    return c.json({ error: "Invalid visibility", kind: "Unknown" }, 400);
  }
  const pollRaw = body.value.poll;
  const pollOptions = pollRaw
    ? [...pollRaw.options].map((option) => option.trim()).filter((option) => option.length > 0)
    : [];
  if (pollRaw) {
    if (
      pollOptions.length < InstanceLimits.poll.minOptions ||
      pollOptions.length > InstanceLimits.poll.maxOptions
    ) {
      return c.json(
        { error: "poll options must be between 2 and 4", kind: "PollOptionsOutOfRange" },
        422,
      );
    }
    if (
      pollOptions.some((option) => characterCount(option) > InstanceLimits.poll.maxOptionCharacters)
    ) {
      return c.json({ error: "poll option is too long", kind: "PollOptionTooLong" }, 422);
    }
  }
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
    const requested = Number(pollRaw?.expires_in ?? 86400);
    const expiresIn = Number.isFinite(requested)
      ? Math.min(
          Math.max(requested, InstanceLimits.poll.minExpirationSeconds),
          InstanceLimits.poll.maxExpirationSeconds,
        )
      : 86400;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
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
  const attributeError = await applyMediaAttributes(c.env, user.value.id, note.id, mediaAttributes);
  if (attributeError) {
    return jsonRepositoryError(c, attributeError);
  }
  const mentionNames = mentionUsernames(note.text);
  const mentionedAccounts = await findAccountsByUsernames(c.env.DB, [...mentionNames]);
  if (mentionedAccounts.isErr()) {
    return jsonRepositoryError(c, mentionedAccounts.error.message);
  }
  const mentionedAccountIds = mentionedAccounts.value.map((account) => account.id);
  // Persist mention rows before side-effect notifies (D1 write strategy / Create saga).
  const mentionsSaved = await replaceStatusMentions(c.env.DB, note.id, mentionedAccountIds);
  if (mentionsSaved.isErr()) {
    return jsonRepositoryError(c, mentionsSaved.error.message);
  }
  for (const mentioned of mentionedAccounts.value) {
    if (mentioned.id === user.value.id) {
      continue;
    }
    await notifyAccount(c.env, {
      accountId: mentioned.id,
      fromAccountId: user.value.id,
      kind: "mention",
      statusId: note.id,
    });
  }
  const actor = InstanceIdentity.actorUrl(identity.value, user.value.username);
  const enqueued = await enqueueLocalActivity(c.env, user.value.id, "Create", {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${actor}/statuses/${note.id}/activity`,
    type: "Create",
    actor,
    object: noteDocument(identity.value, user.value, note),
  });
  if (enqueued.isErr()) {
    return jsonRepositoryError(
      c,
      enqueued.error.kind === "RepositoryError"
        ? enqueued.error.message
        : enqueued.error.kind === "QueueSendFailed"
          ? enqueued.error.message
          : "invalid activity id",
    );
  }
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

const updateStatus = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const found = await findStatusById(c.env.DB, c.req.param("id") ?? "");
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  const existing = found.value;
  if (!existing || existing.kind !== "LocalNote" || existing.accountId !== user.value.id) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const rawBody = await readUnknownBody(c);
  const body = schemaResult(CreateStatusBodySchema)(rawBody).mapErr(() => ({
    kind: "ValidationError" as const,
  }));
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const mediaAttributes = body.value.media_attributes ?? mediaAttributesFromForm(rawBody);
  const pollEdit = body.value.poll;
  let pollUpdate:
    | Readonly<{
        pollId: string;
        options: ReadonlyArray<string>;
        multiple: boolean;
        expiresAt: string;
      }>
    | undefined;
  if (pollEdit) {
    const current = await findPollByStatusId(c.env.DB, existing.id, user.value.id);
    if (current.isErr()) {
      return jsonRepositoryError(c, current.error.message);
    }
    if (!current.value) {
      return c.json({ error: "cannot edit a poll", kind: "PollEditUnsupported" }, 422);
    }
    const votes = await countPollVotes(c.env.DB, current.value.id);
    if (votes.isErr()) {
      return jsonRepositoryError(c, votes.error.message);
    }
    if (votes.value > 0) {
      return c.json(
        { error: "cannot edit a poll after voting has started", kind: "PollVotesCast" },
        422,
      );
    }
    if (Date.parse(current.value.expiresAt) <= Date.now()) {
      return c.json({ error: "cannot edit a poll after it has expired", kind: "PollExpired" }, 422);
    }
    const options = pollEdit.options
      .map((option) => option.trim())
      .filter((option) => option.length > 0);
    if (options.length < 2) {
      return c.json(
        { error: "poll must have at least two options", kind: "PollOptionsRequired" },
        422,
      );
    }
    const expiresIn = pollEdit.expires_in === undefined ? undefined : Number(pollEdit.expires_in);
    pollUpdate = {
      pollId: current.value.id,
      options,
      multiple: isTruthy(pollEdit.multiple),
      expiresAt:
        expiresIn !== undefined && Number.isFinite(expiresIn)
          ? new Date(Date.now() + expiresIn * 1000).toISOString()
          : current.value.expiresAt,
    };
  }
  let visibilityValue = existing.visibility;
  if (body.value.visibility && body.value.visibility.length > 0) {
    const parsedVisibility = Visibility.fromMastodon(body.value.visibility);
    if (parsedVisibility.isErr()) {
      return c.json({ error: "Invalid visibility", kind: "Unknown" }, 400);
    }
    visibilityValue = parsedVisibility.value;
  }
  const composing = StatusComposition.composing({
    text: body.value.status ?? existing.text,
    visibility: visibilityValue,
    spoilerText: body.value.spoiler_text ?? existing.spoilerText,
    sensitive:
      body.value.sensitive !== undefined ? isTruthy(body.value.sensitive) : existing.sensitive,
    language:
      body.value.language === undefined
        ? existing.language
        : body.value.language.length > 0
          ? { kind: "Present", value: body.value.language }
          : { kind: "None" },
    mediaIds:
      body.value.media_ids !== undefined ? stringList(body.value.media_ids) : existing.mediaIds,
    poll: existing.poll,
  });
  const draft = StatusComposition.validate(composing);
  if (draft.isErr()) {
    return c.json({ error: draft.error.kind, kind: draft.error.kind }, 422);
  }
  const revised = LocalStatus.revise(existing, draft.value, textToHtml(draft.value.text));

  // Snapshot the previous revision before mutating, stamped with its revision time.
  const priorUpdatedAt = await findStatusUpdatedAt(c.env.DB, existing.id);
  const revisionAt =
    priorUpdatedAt.isOk() && priorUpdatedAt.value ? priorUpdatedAt.value : existing.createdAt;
  const previousDocument = await mastodonStatus(c.env, identity.value, existing, user.value.id);
  if (previousDocument) {
    const snapshotted = await insertStatusEdit(
      c.env.DB,
      existing.id,
      JSON.stringify({ ...previousDocument, created_at: revisionAt }),
    );
    if (snapshotted.isErr()) {
      return jsonRepositoryError(c, snapshotted.error.message);
    }
  }

  const updatedAt = nowIso();
  const applied = await updateLocalNote(c.env.DB, revised, updatedAt);
  if (applied.isErr()) {
    return jsonRepositoryError(c, applied.error.message);
  }
  if (!applied.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (pollUpdate) {
    const poll = await replacePollOptions(c.env.DB, pollUpdate);
    if (poll.isErr()) {
      return jsonRepositoryError(c, poll.error.message);
    }
  }
  const media = await replaceStatusMedia(c.env.DB, existing.id, user.value.id, revised.mediaIds);
  if (media.isErr()) {
    return jsonRepositoryError(c, media.error.message);
  }
  const attributeError = await applyMediaAttributes(
    c.env,
    user.value.id,
    existing.id,
    mediaAttributes,
  );
  if (attributeError) {
    return jsonRepositoryError(c, attributeError);
  }
  const mentionedAccounts = await findAccountsByUsernames(c.env.DB, [
    ...mentionUsernames(revised.text),
  ]);
  if (mentionedAccounts.isErr()) {
    return jsonRepositoryError(c, mentionedAccounts.error.message);
  }
  const mentions = await replaceStatusMentions(
    c.env.DB,
    existing.id,
    mentionedAccounts.value.map((account) => account.id),
  );
  if (mentions.isErr()) {
    return jsonRepositoryError(c, mentions.error.message);
  }

  const actor = InstanceIdentity.actorUrl(identity.value, user.value.username);
  const enqueued = await enqueueLocalActivity(c.env, user.value.id, "Update", {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${actor}/statuses/${existing.id}/updates/${newEntityId()}`,
    type: "Update",
    actor,
    published: updatedAt,
    object: noteDocument(identity.value, user.value, revised),
  });
  if (enqueued.isErr()) {
    return jsonRepositoryError(
      c,
      enqueued.error.kind === "RepositoryError"
        ? enqueued.error.message
        : enqueued.error.kind === "QueueSendFailed"
          ? enqueued.error.message
          : "invalid activity id",
    );
  }

  const latest = await findStatusById(c.env.DB, existing.id);
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const document = await mastodonStatus(c.env, identity.value, latest.value, user.value.id);
  if (document) {
    await publishToAccount(c.env, user.value.id, { kind: "update", payload: document });
  }
  return c.json(document ?? {});
};

statusRoutes.put("/api/v1/statuses/:id", (c) => updateStatus(c));
statusRoutes.patch("/api/v1/statuses/:id", (c) => updateStatus(c));

statusRoutes.get("/api/v1/statuses/:id/history", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const status = await findStatusById(c.env.DB, c.req.param("id") ?? "");
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  if (!status.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (!(await canViewStatus(c.env.DB, status.value, viewerId))) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (status.value.kind !== "LocalNote") {
    return c.json([]);
  }
  const snapshots = await listStatusEdits(c.env.DB, status.value.id);
  if (snapshots.isErr()) {
    return jsonRepositoryError(c, snapshots.error.message);
  }
  const updatedAt = await findStatusUpdatedAt(c.env.DB, status.value.id);
  const current = await mastodonStatus(c.env, identity.value, status.value, viewerId);
  if (!current) {
    return c.json([]);
  }
  const revisions = [...snapshots.value].reverse();
  const revisionAt = updatedAt.isOk() && updatedAt.value ? updatedAt.value : status.value.createdAt;
  return c.json([...revisions, { ...current, created_at: revisionAt }]);
});

statusRoutes.get("/api/v1/statuses/:id/source", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const status = await findStatusById(c.env.DB, c.req.param("id") ?? "");
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  if (!status.value || status.value.kind !== "LocalNote") {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({
    id: status.value.id,
    text: status.value.text,
    spoiler_text: status.value.spoilerText,
  });
});

const STATUS_PIN_LIMIT = InstanceLimits.account.maxPinnedStatuses;

const setStatusPinned = async (c: Context<{ Bindings: Env }>, pin: boolean): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const found = await findStatusById(c.env.DB, c.req.param("id") ?? "");
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  const existing = found.value;
  if (!existing || existing.kind !== "LocalNote" || existing.accountId !== user.value.id) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (pin) {
    const already = await isStatusPinned(c.env.DB, user.value.id, existing.id);
    if (already.isErr()) {
      return jsonRepositoryError(c, already.error.message);
    }
    if (!already.value) {
      if (existing.visibility.kind === "Direct") {
        return c.json(
          {
            error: "Posts that are only visible to mentioned users cannot be pinned",
            kind: "PinnedDirectUnsupported",
          },
          422,
        );
      }
      const count = await countPinnedStatuses(c.env.DB, user.value.id);
      if (count.isErr()) {
        return jsonRepositoryError(c, count.error.message);
      }
      if (count.value >= STATUS_PIN_LIMIT) {
        return c.json(
          {
            error: "You have already pinned the maximum number of posts",
            kind: "PinnedLimitReached",
          },
          422,
        );
      }
    }
    const pinned = await pinStatus(c.env.DB, user.value.id, existing.id);
    if (pinned.isErr()) {
      return jsonRepositoryError(c, pinned.error.message);
    }
  } else {
    const unpinned = await unpinStatus(c.env.DB, user.value.id, existing.id);
    if (unpinned.isErr()) {
      return jsonRepositoryError(c, unpinned.error.message);
    }
  }
  const latest = await findStatusById(c.env.DB, existing.id);
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
};

statusRoutes.post("/api/v1/statuses/:id/pin", (c) => setStatusPinned(c, true));
statusRoutes.post("/api/v1/statuses/:id/unpin", (c) => setStatusPinned(c, false));

const setStatusMuted = async (c: Context<{ Bindings: Env }>, mute: boolean): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const found = await findStatusById(c.env.DB, c.req.param("id") ?? "");
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  const existing = found.value;
  if (!existing || existing.kind !== "LocalNote") {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const roots = await resolveThreadRootStatusIds(c.env.DB, [existing]);
  if (roots.isErr()) {
    return jsonRepositoryError(c, roots.error.message);
  }
  const rootId = roots.value.get(existing.id) ?? existing.id;
  if (mute) {
    const muted = await muteStatusThread(c.env.DB, user.value.id, rootId);
    if (muted.isErr()) {
      return jsonRepositoryError(c, muted.error.message);
    }
  } else {
    const unmuted = await unmuteStatusThread(c.env.DB, user.value.id, rootId);
    if (unmuted.isErr()) {
      return jsonRepositoryError(c, unmuted.error.message);
    }
  }
  const latest = await findStatusById(c.env.DB, existing.id);
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
};

statusRoutes.post("/api/v1/statuses/:id/mute", (c) => setStatusMuted(c, true));
statusRoutes.post("/api/v1/statuses/:id/unmute", (c) => setStatusMuted(c, false));

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
  const limits = viewerId ? ContextLimits.authenticated : ContextLimits.anonymous;
  const ancestors = await listStatusAncestors(c.env.DB, status.value.id, limits.depth);
  if (ancestors.isErr()) {
    return jsonRepositoryError(c, ancestors.error.message);
  }
  const descendants = await listStatusDescendants(
    c.env.DB,
    status.value.id,
    limits.descendants,
    limits.depth,
  );
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
  const enqueued = await enqueueLocalActivity(c.env, user.value.id, "Announce", {
    type: "Announce",
    actor,
    object: `${actor}/statuses/${status.value.id}`,
  });
  if (enqueued.isErr()) {
    return jsonRepositoryError(
      c,
      enqueued.error.kind === "RepositoryError"
        ? enqueued.error.message
        : enqueued.error.kind === "QueueSendFailed"
          ? enqueued.error.message
          : "invalid activity id",
    );
  }
  const latest = await findStatusById(c.env.DB, reblog.id);
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
    queryCursor(c),
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
    queryCursor(c),
  );
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  return c.json(await mastodonStatuses(c.env, identity.value, statuses.value, user.value.id));
});
