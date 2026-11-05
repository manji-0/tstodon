import {
  type InstanceIdentity,
  type LocalAccount,
  type LocalNote,
  LocalStatus,
  type RemoteActor,
  StatusComposition,
  Visibility,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";
import type { Context } from "hono";
import { findAccountsByUsernames } from "../../account-store";
import { authenticate } from "../../auth";
import { nowIso } from "../../clock";
import { deleteLocalStatus } from "../../local-status-delete";
import { announceNoteUpdate } from "../../local-status-update";
import { mentionUsernames, textToHtml } from "../../html";
import { replaceStatusMentions, replaceStatusRemoteMentions } from "../../mention-store";
import { resolveRemoteMentions } from "../../mention-resolve";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readUnknownBody,
  requireFunctionalUser,
  requireUser,
} from "../../http";
import { mastodonStatus } from "../../local-status-documents";
import { countPollVotes, findPollByStatusId, replacePollOptions } from "../../poll-store";
import {
  CreateStatusBodySchema,
  mediaAttributesFromForm,
  withoutNullFields,
} from "../../status-body-schema";
import { isTruthy, stringList } from "../../form-values";
import { schemaResult } from "@tstodon/core";
import { parseInstanceIdentity } from "../../runtime-config";
import { notifyAccount } from "../../notify";
import { findStatusById, replaceStatusMedia, updateLocalNote } from "../../status-store";
import { findStatusUpdatedAt, insertStatusEdit, listStatusEdits } from "../../status-edit-store";
import { canViewRemoteStatus, canViewStatus } from "../../visibility-guard";
import { findRemoteActorByUri } from "../../remote-actor-store";
import { findRemoteStatusById } from "../../remote-status-store";
import { remoteStatusHistory } from "../../remote-status-edit";
import { isQuotePolicy, listAcceptedQuoteEdges, setStatusQuotePolicy } from "../../quote-store";
import { applyMediaAttributes, queueLinkCard, visibilityIsPublic } from "./create";
import { ApiRefusal } from "../api-refusal";
import type { MediaAttribute } from "../../status-body-schema";

export const deleteV1StatusesById = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id">,
) => {
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
  const deleted = await deleteLocalStatus(c.env, identity.value, user.value, existing.value);
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
};

type UpdateStatusBody = z.infer<typeof CreateStatusBodySchema>;

/** The new options of a poll that may still be edited: no votes yet, not expired. */
type PollUpdate = Readonly<{
  pollId: string;
  options: ReadonlyArray<string>;
  multiple: boolean;
  expiresAt: string;
  hideTotals: boolean;
}>;

const resolvePollEdit = async (
  db: D1Database,
  note: LocalNote,
  viewerId: string,
  pollEdit: UpdateStatusBody["poll"],
): Promise<Result<PollUpdate | undefined, ApiRefusal>> => {
  if (!pollEdit) {
    return ok(undefined);
  }
  const current = await findPollByStatusId(db, note.id, viewerId);
  if (current.isErr()) {
    return err(ApiRefusal.repository(current.error.message));
  }
  if (!current.value) {
    return err(ApiRefusal.rejected(422, "cannot edit a poll", "PollEditUnsupported"));
  }
  const votes = await countPollVotes(db, current.value.id);
  if (votes.isErr()) {
    return err(ApiRefusal.repository(votes.error.message));
  }
  if (votes.value > 0) {
    return err(
      ApiRefusal.rejected(422, "cannot edit a poll after voting has started", "PollVotesCast"),
    );
  }
  if (Date.parse(current.value.expiresAt) <= Date.now()) {
    return err(ApiRefusal.rejected(422, "cannot edit a poll after it has expired", "PollExpired"));
  }
  const options = pollEdit.options
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
  if (options.length < 2) {
    return err(
      ApiRefusal.rejected(422, "poll must have at least two options", "PollOptionsRequired"),
    );
  }
  const expiresIn = pollEdit.expires_in === undefined ? undefined : Number(pollEdit.expires_in);
  return ok({
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
  });
};

/** Store the revision being replaced, stamped with the time it was made. */
const snapshotPreviousRevision = async (
  env: Env,
  identity: InstanceIdentity,
  note: LocalNote,
  viewerId: string,
): Promise<Result<void, ApiRefusal>> => {
  const priorUpdatedAt = await findStatusUpdatedAt(env.DB, note.id);
  const revisionAt =
    priorUpdatedAt.isOk() && priorUpdatedAt.value ? priorUpdatedAt.value : note.createdAt;
  const previousDocument = await mastodonStatus(env, identity, note, viewerId);
  if (!previousDocument) {
    return ok(undefined);
  }
  const snapshotted = await insertStatusEdit(
    env.DB,
    note.id,
    JSON.stringify({ ...previousDocument, created_at: revisionAt }),
  );
  return snapshotted.isErr()
    ? err(ApiRefusal.repository(snapshotted.error.message))
    : ok(undefined);
};

/**
 * Replace the local and remote accounts the revised text mentions; the
 * remote actors come back for the audience of the update.
 */
const replaceMentions = async (
  env: Env,
  identity: InstanceIdentity,
  note: LocalNote,
): Promise<Result<ReadonlyArray<RemoteActor>, ApiRefusal>> => {
  const mentionedAccounts = await findAccountsByUsernames(env.DB, [
    ...mentionUsernames(note.text, identity.domain),
  ]);
  if (mentionedAccounts.isErr()) {
    return err(ApiRefusal.repository(mentionedAccounts.error.message));
  }
  const mentions = await replaceStatusMentions(
    env.DB,
    note.id,
    mentionedAccounts.value.map((account) => account.id),
  );
  if (mentions.isErr()) {
    return err(ApiRefusal.repository(mentions.error.message));
  }
  const remoteMentions = await resolveRemoteMentions(env, identity, note.text);
  const remoteSaved = await replaceStatusRemoteMentions(
    env.DB,
    note.id,
    remoteMentions.map((actor) => actor.actorUri),
  );
  return remoteSaved.isErr()
    ? err(ApiRefusal.repository(remoteSaved.error.message))
    : ok(remoteMentions);
};

/**
 * Revise the author's note from the request, keep the previous revision,
 * store the new one with what hangs off it (poll, quote policy, media,
 * mentions), and announce the update. The steps keep their order, so a
 * refusal leaves exactly what it left before.
 */
const editNote = async (
  env: Env,
  identity: InstanceIdentity,
  author: LocalAccount,
  existing: LocalNote,
  body: UpdateStatusBody,
  mediaAttributes: ReadonlyArray<MediaAttribute>,
): Promise<Result<Record<string, unknown> | undefined, ApiRefusal>> => {
  const pollUpdate = await resolvePollEdit(env.DB, existing, author.id, body.poll);
  if (pollUpdate.isErr()) {
    return err(pollUpdate.error);
  }
  const visibility =
    body.visibility && body.visibility.length > 0
      ? Visibility.fromMastodon(body.visibility)
      : ok(existing.visibility);
  if (visibility.isErr()) {
    return err(ApiRefusal.rejected(400, "Invalid visibility", "Unknown"));
  }
  const draft = StatusComposition.validate(
    StatusComposition.composing({
      text: body.status ?? existing.text,
      visibility: visibility.value,
      spoilerText: body.spoiler_text ?? existing.spoilerText,
      sensitive: body.sensitive !== undefined ? isTruthy(body.sensitive) : existing.sensitive,
      language:
        body.language === undefined
          ? existing.language
          : body.language.length > 0
            ? { kind: "Present", value: body.language }
            : { kind: "None" },
      mediaIds: body.media_ids !== undefined ? stringList(body.media_ids) : existing.mediaIds,
      poll: existing.poll,
    }),
  );
  if (draft.isErr()) {
    return err(ApiRefusal.rejected(422, draft.error.kind, draft.error.kind));
  }
  const revised = LocalStatus.revise(existing, draft.value, textToHtml(draft.value.text));

  const snapshotted = await snapshotPreviousRevision(env, identity, existing, author.id);
  if (snapshotted.isErr()) {
    return err(snapshotted.error);
  }
  const updatedAt = nowIso();
  const applied = await updateLocalNote(env.DB, revised, updatedAt);
  if (applied.isErr()) {
    return err(ApiRefusal.repository(applied.error.message));
  }
  if (!applied.value) {
    return err(ApiRefusal.notFound);
  }
  // Authors who quoted this status hear that the original changed.
  const quoteEdges = await listAcceptedQuoteEdges(env.DB, existing.id);
  const quoters = (quoteEdges.isOk() ? quoteEdges.value : []).filter(
    (edge) => edge.accountId !== author.id,
  );
  for (const edge of quoters) {
    await notifyAccount(env, {
      accountId: edge.accountId,
      fromAccountId: author.id,
      kind: "quoted_update",
      statusId: edge.statusId,
    });
  }
  await queueLinkCard(env, existing.id, revised.text);
  if (pollUpdate.value) {
    const poll = await replacePollOptions(env.DB, pollUpdate.value);
    if (poll.isErr()) {
      return err(ApiRefusal.repository(poll.error.message));
    }
  }
  const policyEdit = (body.quote_approval_policy ?? "").trim().toLowerCase();
  if (policyEdit.length > 0) {
    if (!isQuotePolicy(policyEdit)) {
      return err(ApiRefusal.rejected(422, "Invalid quote_approval_policy", "ValidationError"));
    }
    const stored = await setStatusQuotePolicy(
      env.DB,
      existing.id,
      visibilityIsPublic(revised.visibility) ? policyEdit : "nobody",
    );
    if (stored.isErr()) {
      return err(ApiRefusal.repository(stored.error.message));
    }
  }
  const media = await replaceStatusMedia(env.DB, existing.id, author.id, revised.mediaIds);
  if (media.isErr()) {
    return err(ApiRefusal.repository(media.error.message));
  }
  const attributeError = await applyMediaAttributes(env, author.id, existing.id, mediaAttributes);
  if (attributeError) {
    return err(ApiRefusal.repository(attributeError));
  }
  const remoteMentions = await replaceMentions(env, identity, revised);
  if (remoteMentions.isErr()) {
    return err(remoteMentions.error);
  }
  // An edit reaches the same audience as the note: a direct one only the
  // remote accounts it mentions.
  const announced = await announceNoteUpdate(
    env,
    identity,
    author,
    revised,
    updatedAt,
    !(revised.visibility.kind === "Direct" && remoteMentions.value.length === 0),
  );
  if (announced.isErr()) {
    return err(
      ApiRefusal.repository(
        announced.error.kind === "RepositoryError"
          ? announced.error.message
          : announced.error.kind === "QueueSendFailed"
            ? announced.error.message
            : "invalid activity id",
      ),
    );
  }
  return ok(announced.value);
};

const updateStatus = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireFunctionalUser(c);
  if (user.isErr()) {
    return user.error;
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
  const body = schemaResult(CreateStatusBodySchema)(withoutNullFields(rawBody));
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const edited = await editNote(
    c.env,
    identity.value,
    user.value,
    existing,
    body.value,
    body.value.media_attributes ?? mediaAttributesFromForm(rawBody),
  );
  return edited.isErr() ? ApiRefusal.respond(c, edited.error) : c.json(edited.value ?? {});
};

export const putV1StatusesById = (c: Context<{ Bindings: Env }, "/api/v1/statuses/:id">) =>
  updateStatus(c);
export const patchV1StatusesById = (c: Context<{ Bindings: Env }, "/api/v1/statuses/:id">) =>
  updateStatus(c);

/** The history of a cached remote note the viewer may see, or 404. */
const remoteHistory = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/history">,
  identity: InstanceIdentity,
  id: string,
  viewerId: string | undefined,
) => {
  const remote = await findRemoteStatusById(c.env.DB, id);
  if (remote.isErr()) {
    return jsonRepositoryError(c, remote.error.message);
  }
  if (!remote.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const actor = await findRemoteActorByUri(c.env.DB, remote.value.actorUri);
  if (actor.isErr()) {
    return jsonRepositoryError(c, actor.error.message);
  }
  if (!actor.value || !(await canViewRemoteStatus(c.env.DB, remote.value, viewerId))) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const history = await remoteStatusHistory(c.env.DB, identity, remote.value, actor.value);
  return history.isErr() ? jsonRepositoryError(c, history.error.message) : c.json(history.value);
};

export const getV1StatusesByIdHistory = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/history">,
) => {
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
    return remoteHistory(c, identity.value, c.req.param("id") ?? "", viewerId);
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
};

export const getV1StatusesByIdSource = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/source">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const status = await findStatusById(c.env.DB, c.req.param("id") ?? "");
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  // The source is for the author to edit from: a remote note, or anyone
  // else's, answers as if it did not exist.
  if (
    !status.value ||
    status.value.kind !== "LocalNote" ||
    status.value.accountId !== user.value.id
  ) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({
    id: status.value.id,
    text: status.value.text,
    spoiler_text: status.value.spoilerText,
  });
};
