import {
  ApiCreateStatusParamsSchema,
  type ApiScheduledStatusJSON,
  type ApiStatusJSON,
} from "@tstodon/api";
import {
  type InstanceIdentity,
  type LocalAccount,
  StatusComposition,
  StatusId,
  type StatusTargetValue,
  type ThreadStatus,
  type ValidatedStatusDraft,
  Visibility,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "../../d1";
import type { Context } from "hono";
import { findComposeDefaults } from "../../account-defaults-store";
import { findReplyTarget } from "../../reply-target";
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
  mediaAttributesOf,
  mediaDescriptionsFit,
  withoutNullFields,
} from "../../status-body-schema";
import type { z } from "zod";
import {
  completeStatusIdempotency,
  findStatusIdempotency,
  type IdempotentRecord,
  releaseStatusIdempotency,
  reserveStatusIdempotency,
} from "../../status-idempotency-store";
import { InstanceLimits } from "@tstodon/core";
import type { MediaAttribute } from "../../status-body-schema";
import { parseInstanceIdentity } from "../../runtime-config";
import { findStatusById } from "../../status-store";
import { enqueueLinkCard } from "../../link-card";
import { findUnattachableMediaIds, mediaNotFoundMessage } from "../../media-store";
import { scheduledStatusMedia } from "../scheduled-statuses";
import { type PublishPoll, publishLocalNote } from "../../local-status-publish";
import { quotePolicyName } from "../../quote-policy-name";
import { isQuotePolicy, type QuotePolicy } from "../../quote-store";
import { resolveQuote, visibilityIsPublic } from "../../quote-resolve";
import { ApiRefusal } from "../api-refusal";
import { parseBodyParams } from "../../request-params";
import { checkPollLimits, draftRefusal } from "./status-limits";
import {
  findScheduledStatus,
  insertScheduledStatus,
  MIN_SCHEDULE_OFFSET_MS,
  scheduledStatusDocument,
} from "../../scheduled-status-store";

/** Queue the link preview for a status; the request never waits on it. */
export const queueLinkCard = async (env: Env, statusId: string, text: string): Promise<void> => {
  const queued = await enqueueLinkCard(env, "Status", statusId, text);
  queued;
};

type CreateStatusBody = z.output<typeof ApiCreateStatusParamsSchema>;

/** The poll a new status asks for, with its options trimmed and within the instance limits. */
const parsePollRequest = (
  poll: CreateStatusBody["poll"],
): Result<PublishPoll | null, ApiRefusal> => {
  if (!poll) {
    return ok(null);
  }
  const options = [...poll.options]
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
  if (options.length < InstanceLimits.poll.minOptions) {
    return err(
      ApiRefusal.rejected(
        422,
        "Validation failed: Poll options must have more than one item",
        "PollOptionsOutOfRange",
      ),
    );
  }
  const expiresIn = poll.expires_in ?? 86400;
  const limits = checkPollLimits(options, expiresIn);
  if (limits.isErr()) {
    return err(limits.error);
  }
  return ok({
    options,
    expiresIn,
    multiple: poll.multiple ?? false,
    hideTotals: poll.hide_totals ?? false,
  });
};

/**
 * Refuse `media_ids` naming media the author may not attach (see
 * {@link findUnattachableMediaIds}) with Mastodon's 422.
 */
export const checkAttachableMedia = async (
  db: D1Database,
  accountId: string,
  mediaIds: ReadonlyArray<string>,
  statusId: string | null,
): Promise<Result<void, ApiRefusal>> => {
  if (mediaIds.length === 0) {
    return ok(undefined);
  }
  const unattachable = await findUnattachableMediaIds(db, accountId, mediaIds, statusId);
  if (unattachable.isErr()) {
    return err(ApiRefusal.repository(unattachable.error.message));
  }
  return unattachable.value.length === 0
    ? ok(undefined)
    : err(ApiRefusal.rejected(422, mediaNotFoundMessage(unattachable.value), "ValidationError"));
};

/** Mastodon's `statuses.errors.in_reply_not_found`. */
const replyNotFound = ApiRefusal.rejected(
  404,
  "The post you are trying to reply to does not appear to exist.",
  "NotFound",
);

/** Resolve `in_reply_to_id`: a local or cached remote status shown to the author. */
const resolveReplyTo = async (
  env: Env,
  replyRaw: string,
  authorId: string,
): Promise<Result<ThreadStatus | null, ApiRefusal>> => {
  if (replyRaw.length === 0) {
    return ok(null);
  }
  const replyId = StatusId.parse(replyRaw);
  if (replyId.isErr()) {
    return err(ApiRefusal.rejected(422, "Invalid in_reply_to_id", "ValidationError"));
  }
  const parent = await findReplyTarget(env, replyId.value, authorId);
  if (parent.isErr()) {
    return err(ApiRefusal.repository(parent.error.message));
  }
  return parent.value ? ok(parent.value) : err(replyNotFound);
};

/** Everything a new note carries besides its author and quote, once the request is validated. */
type NoteRequest = Readonly<{
  draft: ValidatedStatusDraft;
  mediaAttributes: ReadonlyArray<MediaAttribute>;
  poll: PublishPoll | null;
  replyTo: ThreadStatus | null;
  quotePolicy: QuotePolicy;
}>;

/**
 * A status (or scheduled status) the request stored, and its rendering for
 * the response. Rendering can fail after the write; the id still stands.
 */
type Written = Readonly<{
  record: IdempotentRecord;
  document: Result<ApiStatusJSON | ApiScheduledStatusJSON, ApiRefusal>;
}>;

/**
 * Store the validated post for later instead of publishing it; the cron
 * publisher replays the same params through `publishLocalNote`.
 */
const scheduleStatus = async (
  db: D1Database,
  identity: InstanceIdentity,
  accountId: string,
  scheduledRaw: string,
  note: NoteRequest,
  quoted: StatusTargetValue | null,
): Promise<Result<Written, ApiRefusal>> => {
  const at = Date.parse(scheduledRaw);
  if (!Number.isFinite(at) || at < Date.now() + MIN_SCHEDULE_OFFSET_MS) {
    return err(
      ApiRefusal.rejected(
        422,
        "scheduled_at must be at least 5 minutes in the future",
        "InvalidScheduledAt",
      ),
    );
  }
  const { draft } = note;
  const stored = await insertScheduledStatus(db, {
    accountId,
    scheduledAt: new Date(at).toISOString(),
    params: {
      text: draft.text,
      visibility: Visibility.toMastodon(draft.visibility),
      spoiler_text: draft.spoilerText,
      sensitive: draft.sensitive,
      language: draft.language.kind === "Present" ? draft.language.value : null,
      media_ids: [...draft.mediaIds],
      media_attributes: note.mediaAttributes.map((attribute) => ({
        id: attribute.id,
        ...(attribute.description === undefined ? {} : { description: attribute.description }),
        ...(attribute.focus === undefined ? {} : { focus: attribute.focus }),
      })),
      poll: note.poll
        ? {
            options: [...note.poll.options],
            expires_in: note.poll.expiresIn,
            multiple: note.poll.multiple,
            hide_totals: note.poll.hideTotals,
          }
        : null,
      in_reply_to_id: note.replyTo === null ? null : note.replyTo.status.id,
      quote_policy: note.quotePolicy,
      quoted_status_id: quoted === null ? null : quoted.statusId,
    },
  });
  if (stored.isErr()) {
    return err(ApiRefusal.repository(stored.error.message));
  }
  return ok({
    record: { kind: "ScheduledStatus", id: stored.value.id },
    document: ok(
      scheduledStatusDocument(stored.value, await scheduledStatusMedia(db, identity, stored.value)),
    ),
  });
};

/**
 * Validate a new status against the author's defaults and what it points at
 * (quote, reply), then publish it, or schedule it when `scheduled_at` is set.
 * The checks keep their order, so the first problem is the one reported.
 * An error means nothing was stored.
 */
const postStatus = async (
  env: Env,
  identity: InstanceIdentity,
  author: LocalAccount,
  body: CreateStatusBody,
  mediaAttributes: ReadonlyArray<MediaAttribute>,
): Promise<Result<Written, ApiRefusal>> => {
  const visibility = Visibility.fromMastodon(
    body.visibility && body.visibility.length > 0
      ? body.visibility
      : Visibility.toMastodon(author.defaultPostVisibility),
  );
  if (visibility.isErr()) {
    return err(ApiRefusal.rejected(400, "Invalid visibility", "Unknown"));
  }
  const poll = parsePollRequest(body.poll);
  if (poll.isErr()) {
    return err(poll.error);
  }
  const text = body.status ?? "";
  const quoted = await resolveQuote(
    env,
    identity,
    author.id,
    body.quoted_status_id?.trim() ?? "",
    text,
    visibility.value,
  );
  if (quoted.isErr()) {
    return err(quoted.error);
  }
  const { quote } = quoted.value;
  // The account's posting defaults fill in what the request omits.
  const composeDefaultsResult = await findComposeDefaults(env.DB, author.id);
  const composeDefaults = composeDefaultsResult.isOk()
    ? composeDefaultsResult.value
    : { language: null, sensitive: false };
  const draft = StatusComposition.validate(
    StatusComposition.composing({
      text,
      visibility: quoted.value.visibility,
      ...(quote ? { quote: { kind: "Quoted", target: quote.quoted } } : {}),
      spoilerText: body.spoiler_text ?? "",
      sensitive: body.sensitive ?? composeDefaults.sensitive,
      language:
        body.language && body.language.length > 0
          ? { kind: "Present", value: body.language }
          : composeDefaults.language !== null
            ? { kind: "Present", value: composeDefaults.language }
            : { kind: "None" },
      mediaIds: body.media_ids ?? [],
      poll: poll.value ? { kind: "Present" } : { kind: "None" },
    }),
  );
  if (draft.isErr()) {
    return err(draftRefusal(draft.error));
  }
  const policyRaw = (body.quote_approval_policy ?? "").trim().toLowerCase();
  const requestedPolicy = isQuotePolicy(policyRaw) ? policyRaw : undefined;
  if (policyRaw.length > 0 && requestedPolicy === undefined) {
    return err(ApiRefusal.rejected(422, "Invalid quote_approval_policy", "ValidationError"));
  }
  if (!mediaDescriptionsFit(mediaAttributes)) {
    return err(ApiRefusal.rejected(422, "description is too long", "ValidationError"));
  }
  const replyTo = await resolveReplyTo(env, body.in_reply_to_id?.trim() ?? "", author.id);
  if (replyTo.isErr()) {
    return err(replyTo.error);
  }
  const media = await checkAttachableMedia(env.DB, author.id, draft.value.mediaIds, null);
  if (media.isErr()) {
    return err(media.error);
  }
  const note: NoteRequest = {
    draft: draft.value,
    mediaAttributes,
    poll: poll.value,
    replyTo: replyTo.value,
    // Direct and followers-only posts are never quotable by anyone else.
    quotePolicy: visibilityIsPublic(draft.value.visibility)
      ? (requestedPolicy ?? quotePolicyName(author.defaultQuotePolicy))
      : "nobody",
  };
  const scheduledRaw = body.scheduled_at?.trim() ?? "";
  if (scheduledRaw.length > 0) {
    // As Mastodon 4.5, the quoted status id goes into the params; the
    // publisher resolves it again when the post is due.
    return scheduleStatus(env.DB, identity, author.id, scheduledRaw, note, quote?.quoted ?? null);
  }
  const published = await publishLocalNote(env, identity, author, {
    ...note,
    quote: quote ? { ...quote, inlineHtml: quote.inlineHtml ?? "" } : null,
  });
  if (published.isErr()) {
    return err(ApiRefusal.repository(published.error.message));
  }
  const document = await mastodonStatus(env, identity, published.value, author.id);
  return ok({
    record: { kind: "Status", id: published.value.id },
    document: document.isErr()
      ? err(ApiRefusal.repository(document.error.message))
      : document.value
        ? ok(document.value)
        : err(ApiRefusal.notFound),
  });
};

/** The response to a create request, and the id of what it stored, if it stored anything. */
type CreateAnswer =
  | Readonly<{ kind: "Unwritten"; response: Response }>
  | Readonly<{ kind: "Written"; record: IdempotentRecord; response: Response }>;

const createStatus = async (c: Context<{ Bindings: Env }>): Promise<CreateAnswer> => {
  const unwritten = (response: Response): CreateAnswer => ({ kind: "Unwritten", response });
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return unwritten(c.json(identity.error, 500));
  }
  const user = await requireFunctionalUser(c);
  if (user.isErr()) {
    return unwritten(user.error);
  }
  // A `null` field is a missing one, as in Rails (the web UI sends
  // `"in_reply_to_id": null` and so on for what the post does not use).
  const body = parseBodyParams(
    ApiCreateStatusParamsSchema,
    withoutNullFields(await readUnknownBody(c)),
  );
  if (body.isErr()) {
    return unwritten(jsonValidationError(c));
  }
  const posted = await postStatus(
    c.env,
    identity.value,
    user.value,
    body.value,
    mediaAttributesOf(body.value.media_attributes),
  );
  if (posted.isErr()) {
    return unwritten(ApiRefusal.respond(c, posted.error));
  }
  const { record, document } = posted.value;
  return {
    kind: "Written",
    record,
    response: document.isOk() ? c.json(document.value, 200) : ApiRefusal.respond(c, document.error),
  };
};

/** The document a finished idempotent request answered with, rendered again. */
const recordDocument = async (
  c: Context<{ Bindings: Env }>,
  record: IdempotentRecord,
  viewerId: string,
): Promise<Result<ApiStatusJSON | ApiScheduledStatusJSON | undefined, RepositoryError>> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return ok(undefined);
  }
  switch (record.kind) {
    case "Status": {
      const status = await findStatusById(c.env.DB, record.id);
      if (status.isErr()) {
        return err(status.error);
      }
      return status.value
        ? mastodonStatus(c.env, identity.value, status.value, viewerId)
        : ok(undefined);
    }
    case "ScheduledStatus": {
      const scheduled = await findScheduledStatus(c.env.DB, viewerId, record.id);
      if (scheduled.isErr()) {
        return err(scheduled.error);
      }
      return ok(
        scheduled.value
          ? scheduledStatusDocument(
              scheduled.value,
              await scheduledStatusMedia(c.env.DB, identity.value, scheduled.value),
            )
          : undefined,
      );
    }
  }
};

/**
 * `Idempotency-Key` on POST /api/v1/statuses: Mastodon stores the response for
 * an hour, so a client retry returns the status the first attempt created
 * instead of posting again. A key still in flight answers 409. The key is
 * recorded as soon as the status is stored, even when rendering it fails, so
 * a retry renders that status again; a create that stored nothing releases
 * the key for a retry.
 */
export const postV1Statuses = async (c: Context<{ Bindings: Env }, "/api/v1/statuses">) => {
  const key = (c.req.header("Idempotency-Key") ?? "").trim();
  if (key.length === 0) {
    return (await createStatus(c)).response;
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const accountId = user.value.id;

  const existing = await findStatusIdempotency(c.env.DB, accountId, key);
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  if (existing.value) {
    if (existing.value.kind === "Pending") {
      return c.json({ error: "Duplicate request in progress", kind: "Conflict" }, 409);
    }
    const document = await recordDocument(c, existing.value, accountId);
    if (document.isErr()) {
      return jsonRepositoryError(c, document.error.message);
    }
    if (!document.value) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    return c.json(document.value);
  }

  const reserved = await reserveStatusIdempotency(c.env.DB, accountId, key);
  if (reserved.isErr()) {
    return jsonRepositoryError(c, reserved.error.message);
  }
  if (!reserved.value) {
    const raced = await findStatusIdempotency(c.env.DB, accountId, key);
    const racedRecord = raced.isOk() ? raced.value : undefined;
    if (racedRecord && racedRecord.kind !== "Pending") {
      const document = await recordDocument(c, racedRecord, accountId);
      if (document.isOk() && document.value) {
        return c.json(document.value);
      }
    }
    return c.json({ error: "Duplicate request in progress", kind: "Conflict" }, 409);
  }

  const answer = await createStatus(c);
  if (answer.kind === "Written") {
    await completeStatusIdempotency(c.env.DB, accountId, key, answer.record);
  } else {
    await releaseStatusIdempotency(c.env.DB, accountId, key);
  }
  return answer.response;
};

/**
 * Who favourited or boosted a status (Mastodon's `favourited_by` and
 * `reblogged_by`). Public for public statuses; anything the requester may not
 * see answers 404 with the privacy-preserving wording Mastodon uses.
 */
