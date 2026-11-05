import {
  InstanceIdentity,
  type LocalAccount,
  type LocalStatus,
  StatusComposition,
  StatusId,
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
import { mastodonMedia } from "../../media-document";
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
  releaseStatusIdempotency,
  reserveStatusIdempotency,
} from "../../status-idempotency-store";
import { characterCount, InstanceLimits } from "@tstodon/core";
import { schemaResult } from "@tstodon/core";
import type { MediaAttribute } from "../../status-body-schema";
import { parseInstanceIdentity } from "../../runtime-config";
import { findStatusById } from "../../status-store";
import { enqueueLinkCard } from "../../link-card";
import { findMediaByIds } from "../../media-store";
import { canViewStatus } from "../../visibility-guard";
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

/** The status a quote post points at, with the link the post renders for it. */
type QuoteTarget = Readonly<{ status: LocalStatus; url: string; inlineHtml: string | null }>;

/**
 * Resolve `quoted_status_id`: a status the author may see and quote. Its
 * policy is the quoted status's stored policy (else its author's default),
 * and a followers-only original clamps the quote to followers-only too, so
 * the visibility the post ends up with comes back with the target.
 */
const resolveQuote = async (
  db: D1Database,
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
  const found = await findStatusById(db, quotedId.value);
  if (found.isErr()) {
    return err(ApiRefusal.repository(found.error.message));
  }
  if (!found.value) {
    return err(ApiRefusal.notFound);
  }
  let target = found.value;
  // Quoting a boost quotes the boosted status, as Mastodon does.
  if (target.kind === "LocalReblog") {
    const original = await findStatusById(db, target.target.statusId);
    if (original.isErr()) {
      return err(ApiRefusal.repository(original.error.message));
    }
    if (!original.value) {
      return err(ApiRefusal.notFound);
    }
    target = original.value;
  }
  if (!(await canViewStatus(db, target, authorId))) {
    return err(ApiRefusal.notFound);
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
    // Mastodon answers 404 for a status it will not let you quote.
    return err(ApiRefusal.notFound);
  }
  if (policy === "followers" && target.accountId !== authorId) {
    const follow = await findFollowKind(db, authorId, target.accountId);
    if (follow.isErr()) {
      return err(ApiRefusal.repository(follow.error.message));
    }
    if (follow.value !== "Accepted") {
      return err(ApiRefusal.notFound);
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

/** Resolve `in_reply_to_id`: a local status or a cached remote one the author may see. */
const resolveReplyTo = async (
  db: D1Database,
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
  const parent = await findReplyTarget(db, replyId.value, authorId);
  if (parent.isErr()) {
    return err(ApiRefusal.repository(parent.error.message));
  }
  return parent.value ? ok(parent.value) : err(ApiRefusal.notFound);
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
type Written = Readonly<{ id: string; document: Result<Record<string, unknown>, ApiRefusal> }>;

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
  const media =
    stored.value.params.media_ids.length > 0
      ? await findMediaByIds(db, [...stored.value.params.media_ids])
      : undefined;
  return ok({
    id: stored.value.id,
    document: ok(
      scheduledStatusDocument(
        stored.value,
        media && media.isOk()
          ? [...media.value.values()].map((attachment) => mastodonMedia(identity, attachment))
          : [],
      ),
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
    env.DB,
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
      ...(quote ? { quote: { kind: "Quoted" as const, statusId: quote.status.id } } : {}),
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
  const replyTo = await resolveReplyTo(env.DB, body.in_reply_to_id?.trim() ?? "", author.id);
  if (replyTo.isErr()) {
    return err(replyTo.error);
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
          quotedStatusId: quote.status.id,
          quotedAccountId: quote.status.accountId,
          inlineHtml: quote.inlineHtml ?? "",
          uri: quote.url,
        }
      : null,
  });
  if (published.isErr()) {
    return err(ApiRefusal.repository(published.error.message));
  }
  const document = await mastodonStatus(env, identity, published.value, author.id);
  return ok({
    id: published.value.id,
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
  | Readonly<{ kind: "Written"; id: string; response: Response }>;

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
  const { id, document } = posted.value;
  return {
    kind: "Written",
    id,
    response: document.isOk() ? c.json(document.value, 200) : ApiRefusal.respond(c, document.error),
  };
};

const statusDocumentById = async (
  c: Context<{ Bindings: Env }>,
  statusId: string,
  viewerId: string,
): Promise<Result<Record<string, unknown> | undefined, RepositoryError>> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return ok(undefined);
  }
  const status = await findStatusById(c.env.DB, statusId);
  if (status.isErr()) {
    return err(status.error);
  }
  return status.value
    ? mastodonStatus(c.env, identity.value, status.value, viewerId)
    : ok(undefined);
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
    if (!existing.value.statusId) {
      return c.json({ error: "Duplicate request in progress", kind: "Conflict" }, 409);
    }
    const document = await statusDocumentById(c, existing.value.statusId, accountId);
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
    const racedId = raced.isOk() ? raced.value?.statusId : undefined;
    if (racedId) {
      const document = await statusDocumentById(c, racedId, accountId);
      if (document.isOk() && document.value) {
        return c.json(document.value);
      }
    }
    return c.json({ error: "Duplicate request in progress", kind: "Conflict" }, 409);
  }

  const answer = await createStatus(c);
  if (answer.kind === "Written") {
    await completeStatusIdempotency(c.env.DB, accountId, key, answer.id);
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
