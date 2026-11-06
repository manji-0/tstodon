import {
  InstanceIdentity,
  type LocalAccount,
  type LocalStatus,
  StatusComposition,
  StatusId,
  StatusTarget,
  type ThreadStatus,
  type ValidatedStatusDraft,
  Visibility,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "../../d1";
import type { Context } from "hono";
import { findAccountById } from "../../account-store";
import { findComposeDefaults } from "../../account-defaults-store";
import { escapeHtml, mentionUsernames } from "../../html";
import { findReplyTarget } from "../../reply-target";
import { findFollowKind } from "../../follow-store";
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
  CreateStatusBodySchema,
  mediaAttributesFromForm,
  mediaDescriptionsFit,
  withoutNullFields,
} from "../../status-body-schema";
import { isTruthy, stringList } from "../../form-values";
import type { z } from "zod";
import {
  completeStatusIdempotency,
  findStatusIdempotency,
  type IdempotentRecord,
  releaseStatusIdempotency,
  reserveStatusIdempotency,
} from "../../status-idempotency-store";
import { characterCount, InstanceLimits } from "@tstodon/core";
import { schemaResult } from "@tstodon/core";
import type { MediaAttribute } from "../../status-body-schema";
import { parseInstanceIdentity } from "../../runtime-config";
import { findStatusById } from "../../status-store";
import { enqueueLinkCard } from "../../link-card";
import { findUnattachableMediaIds, mediaNotFoundMessage } from "../../media-store";
import { scheduledStatusMedia } from "../scheduled-statuses";
import { showsFoundStatus } from "../../found-status";
import { type PublishPoll, publishLocalNote } from "../../local-status-publish";
import { quotePolicyName } from "../../quote-policy-name";
import {
  defaultQuotePolicy,
  findStatusQuotePolicy,
  isQuotePolicy,
  type QuotePolicy,
} from "../../quote-store";
import { ApiRefusal } from "../api-refusal";
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

/** Public and unlisted statuses can be quoted by anyone their policy allows. */
export const visibilityIsPublic = (visibility: Visibility): boolean =>
  visibility.kind === "Public" || visibility.kind === "Unlisted";

type CreateStatusBody = z.infer<typeof CreateStatusBodySchema>;

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
  if (
    options.length < InstanceLimits.poll.minOptions ||
    options.length > InstanceLimits.poll.maxOptions
  ) {
    return err(
      ApiRefusal.rejected(422, "poll options must be between 2 and 4", "PollOptionsOutOfRange"),
    );
  }
  if (options.some((option) => characterCount(option) > InstanceLimits.poll.maxOptionCharacters)) {
    return err(ApiRefusal.rejected(422, "poll option is too long", "PollOptionTooLong"));
  }
  return ok({
    options,
    expiresIn: Number(poll.expires_in ?? 86400),
    multiple: isTruthy(poll.multiple),
    hideTotals: isTruthy(poll.hide_totals),
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

/** Mastodon's `statuses.errors.quoted_status_not_found`. */
const quoteNotFound = ApiRefusal.rejected(
  404,
  "The post you are trying to quote does not appear to exist.",
  "NotFound",
);

/** Mastodon's `statuses.errors.in_reply_not_found`. */
const replyNotFound = ApiRefusal.rejected(
  404,
  "The post you are trying to reply to does not appear to exist.",
  "NotFound",
);

/** The status a quote post points at, with the link the post renders for it. */
type QuoteTarget = Readonly<{ status: LocalStatus; url: string; inlineHtml: string | null }>;

/**
 * Resolve `quoted_status_id`: a local status shown to the author that they
 * may quote. Its policy is the quoted status's stored policy (else its
 * author's default), and a followers-only original clamps the quote to
 * followers-only too, so the visibility the post ends up with comes back with
 * the target. Every refusal answers Mastodon's one 404, as `set_quoted_status`.
 */
const resolveQuote = async (
  env: Env,
  identity: InstanceIdentity,
  authorId: string,
  quotedRaw: string,
  text: string,
  visibility: Visibility,
): Promise<Result<Readonly<{ quote: QuoteTarget | null; visibility: Visibility }>, ApiRefusal>> => {
  if (quotedRaw.length === 0) {
    return ok({ quote: null, visibility });
  }
  const quotedId = StatusId.parse(quotedRaw);
  if (quotedId.isErr()) {
    return err(ApiRefusal.rejected(422, "Invalid quoted_status_id", "ValidationError"));
  }
  const db = env.DB;
  const found = await findStatusById(db, quotedId.value);
  if (found.isErr()) {
    return err(ApiRefusal.repository(found.error.message));
  }
  if (!found.value) {
    return err(quoteNotFound);
  }
  let target = found.value;
  // Quoting a boost quotes the boosted status, as Mastodon does.
  if (target.kind === "LocalReblog") {
    const original = await findStatusById(db, target.target.statusId);
    if (original.isErr()) {
      return err(ApiRefusal.repository(original.error.message));
    }
    if (!original.value) {
      return err(quoteNotFound);
    }
    target = original.value;
  }
  const shown = await showsFoundStatus(env, { kind: "LocalStatus", status: target }, authorId);
  if (shown.isErr()) {
    return err(ApiRefusal.repository(shown.error.message));
  }
  if (!shown.value) {
    return err(quoteNotFound);
  }
  const targetVisibility = Visibility.toMastodon(target.visibility);
  if (targetVisibility === "direct") {
    return err(ApiRefusal.rejected(422, "Direct messages cannot be quoted", "QuoteNotAllowed"));
  }
  const targetAuthor = await findAccountById(db, target.accountId);
  const storedPolicy = await findStatusQuotePolicy(db, target.id);
  const policy: QuotePolicy =
    (storedPolicy.isOk() ? storedPolicy.value : undefined) ??
    (targetAuthor.isOk() && targetAuthor.value
      ? quotePolicyName(targetAuthor.value.defaultQuotePolicy)
      : defaultQuotePolicy(targetVisibility));
  if (policy === "nobody" && target.accountId !== authorId) {
    return err(quoteNotFound);
  }
  if (policy === "followers" && target.accountId !== authorId) {
    const follow = await findFollowKind(db, authorId, target.accountId);
    if (follow.isErr()) {
      return err(ApiRefusal.repository(follow.error.message));
    }
    if (follow.value !== "Accepted") {
      return err(quoteNotFound);
    }
  }
  const clamped =
    targetVisibility === "private" && visibilityIsPublic(visibility)
      ? Visibility.FollowersOnly
      : visibility;
  if (clamped.kind === "Direct" && targetAuthor.isOk() && targetAuthor.value) {
    const mentioned = mentionUsernames(text, identity.domain).includes(
      targetAuthor.value.username.toLowerCase(),
    );
    if (!mentioned) {
      return err(
        ApiRefusal.rejected(
          422,
          "Quoted status author must be mentioned in a direct quote",
          "QuoteNotAllowed",
        ),
      );
    }
  }
  const url =
    targetAuthor.isOk() && targetAuthor.value
      ? `${InstanceIdentity.actorUrl(identity, targetAuthor.value.username)}/statuses/${target.id}`
      : "";
  const inlineHtml =
    url.length > 0 && !text.includes(url)
      ? `<p class="quote-inline">RE: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`
      : null;
  return ok({ quote: { status: target, url, inlineHtml }, visibility: clamped });
};

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
  document: Result<Record<string, unknown>, ApiRefusal>;
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
      ...(quote ? { quote: { kind: "Quoted", target: StatusTarget.local(quote.status.id) } } : {}),
      spoilerText: body.spoiler_text ?? "",
      sensitive:
        body.sensitive === undefined ? composeDefaults.sensitive : isTruthy(body.sensitive),
      language:
        body.language && body.language.length > 0
          ? { kind: "Present", value: body.language }
          : composeDefaults.language !== null
            ? { kind: "Present", value: composeDefaults.language }
            : { kind: "None" },
      mediaIds: stringList(body.media_ids),
      poll: poll.value ? { kind: "Present" } : { kind: "None" },
    }),
  );
  if (draft.isErr()) {
    return err(ApiRefusal.rejected(422, draft.error.kind, draft.error.kind));
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
    return quote
      ? err(ApiRefusal.rejected(422, "Scheduled posts cannot quote a status", "QuoteNotAllowed"))
      : scheduleStatus(env.DB, identity, author.id, scheduledRaw, note);
  }
  const published = await publishLocalNote(env, identity, author, {
    ...note,
    quote: quote
      ? {
          quoted: StatusTarget.local(quote.status.id),
          quotedAccountId: quote.status.accountId,
          inlineHtml: quote.inlineHtml ?? "",
        }
      : null,
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
  const rawBody = await readUnknownBody(c);
  const body = schemaResult(CreateStatusBodySchema)(withoutNullFields(rawBody));
  if (body.isErr()) {
    return unwritten(jsonValidationError(c));
  }
  const posted = await postStatus(
    c.env,
    identity.value,
    user.value,
    body.value,
    body.value.media_attributes ?? mediaAttributesFromForm(rawBody),
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
): Promise<Result<Record<string, unknown> | undefined, RepositoryError>> => {
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
