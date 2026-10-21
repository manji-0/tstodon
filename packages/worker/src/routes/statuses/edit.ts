import { InstanceIdentity, LocalStatus, StatusComposition, Visibility } from "@tstodon/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import { findAccountsByUsernames } from "../../account-store";
import { authenticate } from "../../auth";
import { noteDocument } from "../../activitypub";
import { nowIso } from "../../clock";
import { enqueueLocalActivity } from "../../delivery";
import { mentionUsernames, textToHtml } from "../../html";
import { replaceStatusMentions, replaceStatusRemoteMentions } from "../../mention-store";
import { loadNoteMentions, resolveRemoteMentions } from "../../mention-resolve";
import { loadNoteReply } from "../../reply-target";
import { quotedStatusUri } from "../../quote-uri";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readUnknownBody,
  requireUser,
} from "../../http";
import { newEntityId } from "../../ids";
import { mastodonStatus } from "../../local-status-documents";
import { countPollVotes, findPollByStatusId, replacePollOptions } from "../../poll-store";
import { CreateStatusBodySchema, mediaAttributesFromForm } from "../../status-body-schema";
import { isTruthy, stringList } from "../../form-values";
import { schemaResult } from "@tstodon/core";
import { parseInstanceIdentity } from "../../runtime-config";
import { ok } from "neverthrow";
import { notifyAccount } from "../../notify";
import { publishToAccount } from "../../stream-publish";
import {
  deleteStatus,
  findStatusById,
  replaceStatusMedia,
  updateLocalNote,
} from "../../status-store";
import { findStatusUpdatedAt, insertStatusEdit, listStatusEdits } from "../../status-edit-store";
import { canViewStatus } from "../../visibility-guard";
import { isQuotePolicy, listAcceptedQuoteEdges, setStatusQuotePolicy } from "../../quote-store";
import { applyMediaAttributes, queueLinkCard, visibilityIsPublic } from "./create";

export const statusEditRoutes = new Hono<{ Bindings: Env }>();

statusEditRoutes.delete("/api/v1/statuses/:id", async (c) => {
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
  // Mastodon returns the raw source text so a client can delete and redraft;
  // media attachments and the poll are already part of the rendered document.
  const sourceText = existing.value.kind === "LocalNote" ? existing.value.text : "";
  return c.json({ ...(document ?? {}), text: sourceText });
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
        hideTotals: boolean;
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
      // `hide_totals` is optional on an edit: omitting it keeps the poll's.
      hideTotals:
        pollEdit.hide_totals === undefined
          ? current.value.hideTotals
          : isTruthy(pollEdit.hide_totals),
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
  // Authors who quoted this status hear that the original changed.
  const quoteEdges = await listAcceptedQuoteEdges(c.env.DB, existing.id);
  if (quoteEdges.isOk()) {
    for (const edge of quoteEdges.value) {
      if (edge.accountId === user.value.id) {
        continue;
      }
      await notifyAccount(c.env, {
        accountId: edge.accountId,
        fromAccountId: user.value.id,
        kind: "quoted_update",
        statusId: edge.statusId,
      });
    }
  }
  await queueLinkCard(c.env, existing.id, revised.text);
  if (pollUpdate) {
    const poll = await replacePollOptions(c.env.DB, pollUpdate);
    if (poll.isErr()) {
      return jsonRepositoryError(c, poll.error.message);
    }
  }
  const policyEdit = (body.value.quote_approval_policy ?? "").trim().toLowerCase();
  if (policyEdit.length > 0) {
    if (!isQuotePolicy(policyEdit)) {
      return c.json({ error: "Invalid quote_approval_policy", kind: "ValidationError" }, 422);
    }
    const stored = await setStatusQuotePolicy(
      c.env.DB,
      existing.id,
      visibilityIsPublic(revised.visibility) ? policyEdit : "nobody",
    );
    if (stored.isErr()) {
      return jsonRepositoryError(c, stored.error.message);
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
    ...mentionUsernames(revised.text, identity.value.domain),
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
  const remoteMentions = await resolveRemoteMentions(c.env, identity.value, revised.text);
  const remoteSaved = await replaceStatusRemoteMentions(
    c.env.DB,
    existing.id,
    remoteMentions.map((actor) => actor.actorUri),
  );
  if (remoteSaved.isErr()) {
    return jsonRepositoryError(c, remoteSaved.error.message);
  }

  const quoteUri = await quotedStatusUri(c.env, identity.value, existing.id);
  const actor = InstanceIdentity.actorUrl(identity.value, user.value.username);
  // An edit reaches the same audience as the note: a direct one only the
  // remote accounts it mentions.
  const enqueued =
    revised.visibility.kind === "Direct" && remoteMentions.length === 0
      ? ok(undefined)
      : await enqueueLocalActivity(c.env, user.value.id, "Update", {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: `${actor}/statuses/${existing.id}/updates/${newEntityId()}`,
          type: "Update",
          actor,
          published: updatedAt,
          object: noteDocument(identity.value, user.value, revised, {
            quoteUri,
            mentions: await loadNoteMentions(c.env.DB, identity.value, existing.id),
            reply: await loadNoteReply(c.env.DB, identity.value, revised),
          }),
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

statusEditRoutes.put("/api/v1/statuses/:id", (c) => updateStatus(c));
statusEditRoutes.patch("/api/v1/statuses/:id", (c) => updateStatus(c));

statusEditRoutes.get("/api/v1/statuses/:id/history", async (c) => {
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

statusEditRoutes.get("/api/v1/statuses/:id/source", async (c) => {
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
