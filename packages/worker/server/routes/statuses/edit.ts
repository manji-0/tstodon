import {
  ApiDeleteStatusParamsSchema,
  ApiUpdateStatusParamsSchema,
  type ApiStatusEditJSON,
  type ApiStatusJSON,
  type ApiStatusSourceJSON,
} from "@tstodon/api";
import {
  type InstanceIdentity,
  type LocalAccount,
  type LocalNote,
  LocalStatus,
  type RemoteStatusValue,
  StatusComposition,
  StatusRevision,
  StatusTarget,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";
import type { Context } from "hono";
import { assertNever } from "@tstodon/core";
import { authenticate } from "../../auth";
import { nowIso } from "../../clock";
import { deleteLocalStatus } from "../../local-status-delete";
import { announceNoteUpdate } from "../../local-status-update";
import { formatPostText } from "../../html";
import { replaceStatusMentions, replaceStatusRemoteMentions } from "../../mention-store";
import { mentionLinks, resolveMentions, type ResolvedMentions } from "../../mention-resolve";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readUnknownBody,
  requireFunctionalUser,
  requireUser,
} from "../../http";
import { mastodonStatus } from "../../local-status-documents";
import {
  deletePoll,
  findPollByStatusId,
  insertPoll,
  renewPoll,
  replacePollQuestion,
} from "../../poll-store";
import {
  mediaAttributesOf,
  mediaDescriptionsFit,
  withoutNullFields,
} from "../../status-body-schema";
import { parseBodyParams, readOptionalParams, readQueryParams } from "../../request-params";
import { parseInstanceIdentity } from "../../runtime-config";
import { notifyAccount } from "../../notify";
import { findStatusById, replaceStatusMedia, updateLocalNote } from "../../status-store";
import {
  findStatusUpdatedAt,
  insertStatusEdit,
  listStatusEdits,
  statusEditSnapshotOf,
} from "../../status-edit-store";
import { availableAccountDocumentsByIds } from "../../account-documents";
import { RemoteAccountId } from "../../remote-account-id";
import { findShownStatusAnywhere } from "../../found-status";
import { remoteStatusHistory } from "../../remote-status-edit";
import {
  findQuoteByQuoting,
  findStatusQuotePolicy,
  isQuotePolicy,
  listAcceptedQuoteEdges,
  setStatusQuotePolicy,
} from "../../quote-store";
import {
  mediaAttributeChanges,
  type PublishPoll,
  writeMediaAttributes,
} from "../../local-status-publish";
import { checkAttachableMedia, parsePollRequest } from "./create";
import { startLinkCard } from "../../link-card";
import { draftRefusal } from "./status-limits";
import { visibilityIsPublic } from "../../quote-resolve";
import { ApiRefusal } from "../api-refusal";
import type { MediaAttribute } from "../../status-body-schema";

/**
 * Mastodon 4.4's `delete_media`, from the query or the body: set, the media
 * goes with the status; left out, it stays unattached for a redraft, as the
 * web UI's "Delete & redraft" relies on, until the media sweep removes it.
 */
const deleteMediaRequested = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id">,
): Promise<boolean> => {
  const query = readQueryParams(c, ApiDeleteStatusParamsSchema);
  if (query.isOk() && query.value.delete_media === true) {
    return true;
  }
  const body = await readOptionalParams(c, ApiDeleteStatusParamsSchema);
  return body.isOk() && body.value.delete_media === true;
};

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
  if (document.isErr()) {
    return jsonRepositoryError(c, document.error.message);
  }
  const deleted = await deleteLocalStatus(
    c.env,
    identity.value,
    user.value,
    existing.value,
    (await deleteMediaRequested(c)) ? "Delete" : "Keep",
  );
  if (deleted.isErr()) {
    return jsonRepositoryError(c, deleted.error.message);
  }
  if (!deleted.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  // Mastodon returns the raw source text so a client can delete and redraft;
  // media attachments and the poll are already part of the rendered document.
  const sourceText = existing.value.kind === "LocalNote" ? existing.value.text : "";
  return c.json({ ...document.value, text: sourceText });
};

type UpdateStatusBody = z.output<typeof ApiUpdateStatusParamsSchema>;

/**
 * What a revision does to the note's poll, as Mastodon's
 * `UpdateStatusService#update_poll!`: the request's poll is the note's poll
 * from then on. A poll whose options or `multiple` change is a new question
 * and loses its votes; one that repeats them keeps its votes.
 */
type PollRevision =
  | Readonly<{ kind: "Unchanged" }>
  | Readonly<{ kind: "Removed"; pollId: string }>
  | Readonly<{ kind: "Added"; poll: PublishPoll }>
  | Readonly<{ kind: "Renewed"; pollId: string; expiresAt: string; hideTotals: boolean }>
  | Readonly<{
      kind: "Replaced";
      pollId: string;
      options: ReadonlyArray<string>;
      multiple: boolean;
      expiresAt: string;
      hideTotals: boolean;
    }>;

const expiresAfter = (seconds: number): string =>
  new Date(Date.now() + seconds * 1000).toISOString();

const resolvePollRevision = async (
  db: D1Database,
  note: LocalNote,
  viewerId: string,
  requested: UpdateStatusBody["poll"],
): Promise<Result<PollRevision, ApiRefusal>> => {
  const current = await findPollByStatusId(db, note.id, viewerId);
  if (current.isErr()) {
    return err(ApiRefusal.repository(current.error.message));
  }
  const poll = parsePollRequest(requested);
  if (poll.isErr()) {
    return err(poll.error);
  }
  if (!poll.value) {
    return ok(
      current.value ? { kind: "Removed", pollId: current.value.id } : { kind: "Unchanged" },
    );
  }
  // Mastodon sets the end from `expires_in` on every edit, so a poll that
  // leaves it out has no end and `Poll` refuses it.
  if (requested?.expires_in === undefined) {
    return err(
      ApiRefusal.rejected(422, "Validation failed: Deadline can't be blank", "PollExpiration"),
    );
  }
  if (!current.value) {
    return ok({ kind: "Added", poll: poll.value });
  }
  const { options, multiple, hideTotals } = poll.value;
  const expiresAt = expiresAfter(poll.value.expiresIn);
  // Mastodon compares the request's options as sent, before `Poll` strips
  // them, and its `multiple` cast to a boolean, so one left out (`nil`)
  // differs from a stored `false`.
  const sameQuestion =
    requested.multiple === current.value.multiple &&
    requested.options.length === current.value.options.length &&
    requested.options.every((title, index) => title === current.value?.options[index]?.title);
  return ok(
    sameQuestion
      ? { kind: "Renewed", pollId: current.value.id, expiresAt, hideTotals }
      : { kind: "Replaced", pollId: current.value.id, options, multiple, expiresAt, hideTotals },
  );
};

const applyPollRevision = async (
  db: D1Database,
  statusId: string,
  revision: PollRevision,
): Promise<Result<void, ApiRefusal>> => {
  const applied = await (async () => {
    switch (revision.kind) {
      case "Unchanged":
        return ok(undefined);
      case "Removed":
        return deletePoll(db, revision.pollId);
      case "Added":
        return (
          await insertPoll(db, {
            statusId,
            multiple: revision.poll.multiple,
            expiresAt: expiresAfter(revision.poll.expiresIn),
            options: revision.poll.options,
            hideTotals: revision.poll.hideTotals,
          })
        ).map(() => undefined);
      case "Renewed":
        return renewPoll(db, revision);
      case "Replaced":
        return replacePollQuestion(db, revision);
      default:
        return assertNever(revision);
    }
  })();
  return applied.mapErr((error) => ApiRefusal.repository(error.message));
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
  if (previousDocument.isErr()) {
    return err(ApiRefusal.repository(previousDocument.error.message));
  }
  if (!previousDocument.value) {
    return ok(undefined);
  }
  const snapshotted = await insertStatusEdit(
    env.DB,
    note.id,
    statusEditSnapshotOf(previousDocument.value, revisionAt),
  );
  return snapshotted.isErr()
    ? err(ApiRefusal.repository(snapshotted.error.message))
    : ok(undefined);
};

/** Replace the local and remote accounts the revised text mentions. */
const replaceMentions = async (
  env: Env,
  note: LocalNote,
  resolved: ResolvedMentions,
): Promise<Result<void, ApiRefusal>> => {
  const mentions = await replaceStatusMentions(
    env.DB,
    note.id,
    resolved.locals.map((account) => account.id),
  );
  if (mentions.isErr()) {
    return err(ApiRefusal.repository(mentions.error.message));
  }
  const remoteSaved = await replaceStatusRemoteMentions(
    env.DB,
    note.id,
    resolved.remotes.map((actor) => actor.actorUri),
  );
  return remoteSaved.isErr()
    ? err(ApiRefusal.repository(remoteSaved.error.message))
    : ok(undefined);
};

/**
 * Revise the author's note from the request, keep the previous revision,
 * store the new one with what hangs off it (poll, quote policy, media,
 * mentions), and announce the update. Every request field is checked
 * before the first write, so a refused edit leaves the note as it was.
 * The response is rendered after the edit is stored and announced, so a
 * failed render answers 500 (or 404) although the edit stands.
 *
 * As Mastodon's `UpdateStatusService`, the request is the whole revision: a
 * content warning, sensitive flag, media or poll it leaves out is removed
 * (`StatusRevision.content`, `PollRevision`). The language and the quote
 * policy stay when the request names none, and the visibility always stays:
 * an edit cannot change who a note reaches. A request that changes nothing
 * stores no revision and sends no `Update` (Mastodon's
 * `NoChangesSubmittedError`), so a retry with the same body is no edit,
 * unless it names a poll, whose end every edit moves.
 */
const editNote = async (
  env: Env,
  identity: InstanceIdentity,
  author: LocalAccount,
  existing: LocalNote,
  body: UpdateStatusBody,
  mediaAttributes: ReadonlyArray<MediaAttribute>,
): Promise<Result<ApiStatusJSON, ApiRefusal>> => {
  const pollRevision = await resolvePollRevision(env.DB, existing, author.id, body.poll);
  if (pollRevision.isErr()) {
    return err(pollRevision.error);
  }
  // Only a revision without text asks whether the note quotes a status.
  const quote =
    (body.status ?? "").trim().length === 0
      ? await findQuoteByQuoting(env.DB, StatusTarget.local(existing.id))
      : ok(undefined);
  if (quote.isErr()) {
    return err(ApiRefusal.repository(quote.error.message));
  }
  const content = StatusRevision.content(
    {
      spoilerText: existing.spoilerText,
      language: existing.language,
      quotes: quote.value !== undefined,
    },
    {
      text: body.status,
      spoilerText: body.spoiler_text,
      sensitive: body.sensitive,
      language: body.language ?? undefined,
    },
  );
  const hasPoll = pollRevision.value.kind !== "Removed" && pollRevision.value.kind !== "Unchanged";
  const draft = StatusComposition.validate(
    StatusComposition.composing({
      ...content,
      visibility: existing.visibility,
      mediaIds: body.media_ids ?? [],
      poll: hasPoll ? { kind: "Present" } : { kind: "None" },
    }),
  );
  if (draft.isErr()) {
    return err(draftRefusal(draft.error));
  }
  const policyRaw = (body.quote_approval_policy ?? "").trim().toLowerCase();
  const policyEdit = isQuotePolicy(policyRaw) ? policyRaw : undefined;
  if (policyRaw.length > 0 && policyEdit === undefined) {
    return err(ApiRefusal.rejected(422, "Invalid quote_approval_policy", "ValidationError"));
  }
  if (!mediaDescriptionsFit(mediaAttributes)) {
    return err(ApiRefusal.rejected(422, "description is too long", "ValidationError"));
  }
  const media = await checkAttachableMedia(env.DB, author.id, draft.value.mediaIds, existing.id);
  if (media.isErr()) {
    return err(media.error);
  }
  // Resolved before the first write: the revision's HTML links the mentions that resolve.
  const mentioned = await resolveMentions(env, identity, draft.value.text);
  if (mentioned.isErr()) {
    return err(ApiRefusal.repository(mentioned.error.message));
  }
  const revised = LocalStatus.revise(
    existing,
    draft.value,
    formatPostText(draft.value.text, {
      identity,
      mentions: mentionLinks(identity, mentioned.value),
    }),
  );
  const mediaChanges = await mediaAttributeChanges(
    env.DB,
    author.id,
    revised.mediaIds,
    mediaAttributes,
  );
  if (mediaChanges.isErr()) {
    return err(ApiRefusal.repository(mediaChanges.error.message));
  }
  const policy =
    policyEdit === undefined
      ? undefined
      : visibilityIsPublic(revised.visibility)
        ? policyEdit
        : "nobody";
  const storedPolicy =
    policy === undefined ? ok(undefined) : await findStatusQuotePolicy(env.DB, existing.id);
  if (storedPolicy.isErr()) {
    return err(ApiRefusal.repository(storedPolicy.error.message));
  }
  // Mastodon's `significant_changes?`: an edit that changes nothing raises
  // `NoChangesSubmittedError`, which stores nothing and answers the status.
  // It compares the text and warning as sent, before `prepare_contents`
  // strips them, so a change of surrounding whitespace is an edit.
  const changed =
    StatusRevision.changesNote(existing, {
      ...revised,
      text: content.text,
      spoilerText: content.spoilerText,
    }) ||
    pollRevision.value.kind !== "Unchanged" ||
    mediaChanges.value.length > 0 ||
    (policy !== undefined && policy !== storedPolicy.value);
  if (!changed) {
    const current = await mastodonStatus(env, identity, existing, author.id);
    if (current.isErr()) {
      return err(ApiRefusal.repository(current.error.message));
    }
    return current.value ? ok(current.value) : err(ApiRefusal.notFound);
  }

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
  startLinkCard(env, "Status", existing.id, revised.text);
  const pollApplied = await applyPollRevision(env.DB, existing.id, pollRevision.value);
  if (pollApplied.isErr()) {
    return err(pollApplied.error);
  }
  if (policy !== undefined) {
    const stored = await setStatusQuotePolicy(env.DB, existing.id, policy);
    if (stored.isErr()) {
      return err(ApiRefusal.repository(stored.error.message));
    }
  }
  const replaced = await replaceStatusMedia(env.DB, existing.id, author.id, revised.mediaIds);
  if (replaced.isErr()) {
    return err(ApiRefusal.repository(replaced.error.message));
  }
  const attributesWritten = await writeMediaAttributes(env.DB, mediaChanges.value);
  if (attributesWritten.isErr()) {
    return err(ApiRefusal.repository(attributesWritten.error.message));
  }
  const mentionsReplaced = await replaceMentions(env, revised, mentioned.value);
  if (mentionsReplaced.isErr()) {
    return err(mentionsReplaced.error);
  }
  // An edit reaches the same audience as the note: a direct one only the
  // remote accounts it mentions.
  const announced = await announceNoteUpdate(
    env,
    identity,
    author,
    revised,
    updatedAt,
    !(revised.visibility.kind === "Direct" && mentioned.value.remotes.length === 0),
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
  return announced.value ? ok(announced.value) : err(ApiRefusal.notFound);
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
  // A `null` field is one the request leaves out.
  const body = parseBodyParams(
    ApiUpdateStatusParamsSchema,
    withoutNullFields(await readUnknownBody(c)),
  );
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const edited = await editNote(
    c.env,
    identity.value,
    user.value,
    existing,
    body.value,
    mediaAttributesOf(body.value.media_attributes),
  );
  return edited.isErr() ? ApiRefusal.respond(c, edited.error) : c.json(edited.value);
};

export const putV1StatusesById = (c: Context<{ Bindings: Env }, "/api/v1/statuses/:id">) =>
  updateStatus(c);
export const patchV1StatusesById = (c: Context<{ Bindings: Env }, "/api/v1/statuses/:id">) =>
  updateStatus(c);

/** The history of a cached remote note the viewer may be shown. */
const remoteHistory = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/history">,
  identity: InstanceIdentity,
  remote: RemoteStatusValue,
) => {
  const authorId = RemoteAccountId.encode(remote.actorUri);
  const authors = await availableAccountDocumentsByIds(c.env, identity, [authorId]);
  if (authors.isErr()) {
    return jsonRepositoryError(c, authors.error.message);
  }
  const author = authors.value.get(authorId);
  if (!author) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const history = await remoteStatusHistory(c.env.DB, remote, author);
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
  const found = await findShownStatusAnywhere(c.env, c.req.param("id") ?? "", viewerId);
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (found.value.kind === "RemoteStatus") {
    return remoteHistory(c, identity.value, found.value.status);
  }
  const status = found.value.status;
  if (status.kind !== "LocalNote") {
    return c.json([]);
  }
  const snapshots = await listStatusEdits(c.env.DB, status.id);
  if (snapshots.isErr()) {
    return jsonRepositoryError(c, snapshots.error.message);
  }
  const updatedAt = await findStatusUpdatedAt(c.env.DB, status.id);
  const current = await mastodonStatus(c.env, identity.value, status, viewerId);
  if (current.isErr()) {
    return jsonRepositoryError(c, current.error.message);
  }
  if (!current.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  // Each revision with the author as it is now, as Mastodon's `StatusEdit#account`.
  const author = current.value.account;
  const revisions = snapshots.value
    .toReversed()
    .map((snapshot): ApiStatusEditJSON => ({ ...snapshot, account: author }));
  const revisionAt = updatedAt.isOk() && updatedAt.value ? updatedAt.value : status.createdAt;
  return c.json([
    ...revisions,
    { ...statusEditSnapshotOf(current.value, revisionAt), account: author },
  ]);
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
  const source: ApiStatusSourceJSON = {
    id: status.value.id,
    text: status.value.text,
    spoiler_text: status.value.spoilerText,
  };
  return c.json(source);
};
