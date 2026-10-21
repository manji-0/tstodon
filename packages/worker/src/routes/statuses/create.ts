import {
  InstanceIdentity,
  type LocalStatus,
  StatusComposition,
  StatusId,
  Visibility,
} from "@tstodon/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import { findAccountById } from "../../account-store";
import { findComposeDefaults } from "../../account-defaults-store";
import { escapeHtml, mentionUsernames } from "../../html";
import { findReplyTarget, type ReplyTarget } from "../../reply-target";
import { findFollowKind } from "../../follow-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readUnknownBody,
  requireUser,
} from "../../http";
import { mastodonMedia } from "../../media-document";
import { mastodonStatus } from "../../local-status-documents";
import { CreateStatusBodySchema, mediaAttributesFromForm } from "../../status-body-schema";
import { isTruthy, stringList } from "../../form-values";
import { z } from "zod";
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
import {
  findMediaById,
  findMediaByIds,
  parseMediaFocus,
  updateMediaMetadata,
} from "../../media-store";
import { canViewStatus } from "../../visibility-guard";
import { publishLocalNote } from "../../local-status-publish";
import { quotePolicyName } from "../../quote-policy-name";
import {
  defaultQuotePolicy,
  findStatusQuotePolicy,
  isQuotePolicy,
  type QuotePolicy,
} from "../../quote-store";
import {
  insertScheduledStatus,
  MIN_SCHEDULE_OFFSET_MS,
  scheduledStatusDocument,
} from "../../scheduled-status-store";

export const statusCreateRoutes = new Hono<{ Bindings: Env }>();

/** Apply `media_attributes` to media already attached to this status. */
export const applyMediaAttributes = async (
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

/** Queue the link preview for a status; the request never waits on it. */
export const queueLinkCard = async (env: Env, statusId: string, text: string): Promise<void> => {
  const queued = await enqueueLinkCard(env, "Status", statusId, text);
  queued;
};

/** Public and unlisted statuses can be quoted by anyone their policy allows. */
export const visibilityIsPublic = (visibility: Visibility): boolean =>
  visibility.kind === "Public" || visibility.kind === "Unlisted";

const createStatus = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
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
  // A quote post points at another status the author may see. Its policy is
  // the quoted status's stored policy (else its author's default), and a
  // followers-only original clamps the quote to followers-only too.
  let quotedStatus: LocalStatus | undefined;
  let statusVisibility = visibility.value;
  let quoteInlineHtml: string | null = null;
  let quotedUrl = "";
  const quotedRaw = body.value.quoted_status_id?.trim() ?? "";
  if (quotedRaw.length > 0) {
    const quotedId = StatusId.parse(quotedRaw);
    if (quotedId.isErr()) {
      return c.json({ error: "Invalid quoted_status_id", kind: "ValidationError" }, 422);
    }
    const found = await findStatusById(c.env.DB, quotedId.value);
    if (found.isErr()) {
      return jsonRepositoryError(c, found.error.message);
    }
    if (!found.value) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    let target = found.value;
    // Quoting a boost quotes the boosted status, as Mastodon does.
    if (target.kind === "LocalReblog") {
      const original = await findStatusById(c.env.DB, target.reblogOfId);
      if (original.isErr()) {
        return jsonRepositoryError(c, original.error.message);
      }
      if (!original.value) {
        return c.json({ error: "Record not found", kind: "NotFound" }, 404);
      }
      target = original.value;
    }
    if (!(await canViewStatus(c.env.DB, target, user.value.id))) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    const targetVisibility = Visibility.toMastodon(target.visibility);
    if (targetVisibility === "direct") {
      return c.json({ error: "Direct messages cannot be quoted", kind: "QuoteNotAllowed" }, 422);
    }
    const targetAuthor = await findAccountById(c.env.DB, target.accountId);
    const storedPolicy = await findStatusQuotePolicy(c.env.DB, target.id);
    const policy: QuotePolicy =
      (storedPolicy.isOk() ? storedPolicy.value : undefined) ??
      (targetAuthor.isOk() && targetAuthor.value
        ? quotePolicyName(targetAuthor.value.defaultQuotePolicy)
        : defaultQuotePolicy(targetVisibility));
    if (policy === "nobody" && target.accountId !== user.value.id) {
      // Mastodon answers 404 for a status it will not let you quote.
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    if (policy === "followers" && target.accountId !== user.value.id) {
      const follow = await findFollowKind(c.env.DB, user.value.id, target.accountId);
      if (follow.isErr()) {
        return jsonRepositoryError(c, follow.error.message);
      }
      if (follow.value !== "Accepted") {
        return c.json({ error: "Record not found", kind: "NotFound" }, 404);
      }
    }
    if (targetVisibility === "private" && visibilityIsPublic(statusVisibility)) {
      statusVisibility = Visibility.FollowersOnly;
    }
    if (statusVisibility.kind === "Direct" && targetAuthor.isOk() && targetAuthor.value) {
      const mentioned = mentionUsernames(body.value.status ?? "", identity.value.domain).includes(
        targetAuthor.value.username.toLowerCase(),
      );
      if (!mentioned) {
        return c.json(
          {
            error: "Quoted status author must be mentioned in a direct quote",
            kind: "QuoteNotAllowed",
          },
          422,
        );
      }
    }
    quotedStatus = target;
    quotedUrl =
      targetAuthor.isOk() && targetAuthor.value
        ? `${InstanceIdentity.actorUrl(identity.value, targetAuthor.value.username)}/statuses/${target.id}`
        : "";
    if (quotedUrl.length > 0 && !(body.value.status ?? "").includes(quotedUrl)) {
      quoteInlineHtml = `<p class="quote-inline">RE: <a href="${escapeHtml(quotedUrl)}">${escapeHtml(quotedUrl)}</a></p>`;
    }
  }
  // The account's posting defaults fill in what the request omits.
  const composeDefaultsResult = await findComposeDefaults(c.env.DB, user.value.id);
  const composeDefaults = composeDefaultsResult.isOk()
    ? composeDefaultsResult.value
    : { language: null, sensitive: false };
  const composing = StatusComposition.composing({
    text: body.value.status ?? "",
    visibility: statusVisibility,
    ...(quotedStatus ? { quote: { kind: "Quoted" as const, statusId: quotedStatus.id } } : {}),
    spoilerText: body.value.spoiler_text ?? "",
    sensitive:
      body.value.sensitive === undefined
        ? composeDefaults.sensitive
        : isTruthy(body.value.sensitive),
    language:
      body.value.language && body.value.language.length > 0
        ? { kind: "Present", value: body.value.language }
        : composeDefaults.language !== null
          ? { kind: "Present", value: composeDefaults.language }
          : { kind: "None" },
    mediaIds: stringList(body.value.media_ids),
    poll: pollOptions.length >= 2 ? { kind: "Present" } : { kind: "None" },
  });
  const draft = StatusComposition.validate(composing);
  if (draft.isErr()) {
    return c.json({ error: draft.error.kind, kind: draft.error.kind }, 422);
  }
  const policyRaw = (body.value.quote_approval_policy ?? "").trim().toLowerCase();
  const requestedPolicy = isQuotePolicy(policyRaw) ? policyRaw : undefined;
  if (policyRaw.length > 0 && requestedPolicy === undefined) {
    return c.json({ error: "Invalid quote_approval_policy", kind: "ValidationError" }, 422);
  }
  // Direct and followers-only posts are never quotable by anyone else.
  const statusQuotePolicy: QuotePolicy = visibilityIsPublic(draft.value.visibility)
    ? (requestedPolicy ?? quotePolicyName(user.value.defaultQuotePolicy))
    : "nobody";
  let replyTo: ReplyTarget | null = null;
  const replyRaw = body.value.in_reply_to_id?.trim() ?? "";
  if (replyRaw.length > 0) {
    const replyId = StatusId.parse(replyRaw);
    if (replyId.isErr()) {
      return c.json({ error: "Invalid in_reply_to_id", kind: "ValidationError" }, 422);
    }
    // A local status or a cached remote one the author may see.
    const parent = await findReplyTarget(c.env.DB, replyId.value, user.value.id);
    if (parent.isErr()) {
      return jsonRepositoryError(c, parent.error.message);
    }
    if (!parent.value) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    replyTo = parent.value;
  }
  // `scheduled_at` stores the validated post instead of publishing it; the
  // cron publisher replays the same params through `publishLocalNote`.
  const scheduledRaw = body.value.scheduled_at?.trim() ?? "";
  if (scheduledRaw.length > 0) {
    if (quotedStatus) {
      return c.json(
        { error: "Scheduled posts cannot quote a status", kind: "QuoteNotAllowed" },
        422,
      );
    }
    const at = Date.parse(scheduledRaw);
    if (!Number.isFinite(at) || at < Date.now() + MIN_SCHEDULE_OFFSET_MS) {
      return c.json(
        {
          error: "scheduled_at must be at least 5 minutes in the future",
          kind: "InvalidScheduledAt",
        },
        422,
      );
    }
    const stored = await insertScheduledStatus(c.env.DB, {
      accountId: user.value.id,
      scheduledAt: new Date(at).toISOString(),
      params: {
        text: draft.value.text,
        visibility: Visibility.toMastodon(draft.value.visibility),
        spoiler_text: draft.value.spoilerText,
        sensitive: draft.value.sensitive,
        language: draft.value.language.kind === "Present" ? draft.value.language.value : null,
        media_ids: [...draft.value.mediaIds],
        media_attributes: mediaAttributes.map((attribute) => ({
          id: attribute.id,
          ...(attribute.description === undefined ? {} : { description: attribute.description }),
          ...(attribute.focus === undefined ? {} : { focus: attribute.focus }),
        })),
        poll:
          pollOptions.length >= 2
            ? {
                options: [...pollOptions],
                expires_in: Number(pollRaw?.expires_in ?? 86400),
                multiple: isTruthy(pollRaw?.multiple),
                hide_totals: isTruthy(pollRaw?.hide_totals),
              }
            : null,
        in_reply_to_id: replyTo === null ? null : replyTo.status.id,
        quote_policy: statusQuotePolicy,
      },
    });
    if (stored.isErr()) {
      return jsonRepositoryError(c, stored.error.message);
    }
    const media =
      stored.value.params.media_ids.length > 0
        ? await findMediaByIds(c.env.DB, [...stored.value.params.media_ids])
        : undefined;
    return c.json(
      scheduledStatusDocument(
        stored.value,
        media && media.isOk()
          ? [...media.value.values()].map((attachment) => mastodonMedia(identity.value, attachment))
          : [],
      ),
      200,
    );
  }
  const published = await publishLocalNote(c.env, identity.value, user.value, {
    draft: draft.value,
    replyTo,
    quote: quotedStatus
      ? {
          quotedStatusId: quotedStatus.id,
          quotedAccountId: quotedStatus.accountId,
          inlineHtml: quoteInlineHtml ?? "",
          uri: quotedUrl,
        }
      : null,
    quotePolicy: statusQuotePolicy,
    mediaAttributes,
    poll:
      pollOptions.length >= 2
        ? {
            options: pollOptions,
            expiresIn: Number(pollRaw?.expires_in ?? 86400),
            multiple: isTruthy(pollRaw?.multiple),
            hideTotals: isTruthy(pollRaw?.hide_totals),
          }
        : null,
  });
  if (published.isErr()) {
    return jsonRepositoryError(c, published.error.message);
  }
  const document = await mastodonStatus(c.env, identity.value, published.value, user.value.id);
  return c.json(document, 200);
};

const statusDocumentById = async (
  c: Context<{ Bindings: Env }>,
  statusId: string,
  viewerId: string,
): Promise<Record<string, unknown> | undefined> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return undefined;
  }
  const status = await findStatusById(c.env.DB, statusId);
  if (status.isErr() || !status.value) {
    return undefined;
  }
  return mastodonStatus(c.env, identity.value, status.value, viewerId);
};

/**
 * `Idempotency-Key` on POST /api/v1/statuses: Mastodon stores the response for
 * an hour, so a client retry returns the status the first attempt created
 * instead of posting again. A key still in flight answers 409, and a failed
 * create releases the key for a retry.
 */
statusCreateRoutes.post("/api/v1/statuses", async (c) => {
  const key = (c.req.header("Idempotency-Key") ?? "").trim();
  if (key.length === 0) {
    return createStatus(c);
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
    if (!document) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    return c.json(document);
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
      if (document) {
        return c.json(document);
      }
    }
    return c.json({ error: "Duplicate request in progress", kind: "Conflict" }, 409);
  }

  const response = await createStatus(c);
  if (response.ok) {
    const body: unknown = await response.clone().json();
    const parsed = schemaResult(z.object({ id: z.string().min(1) }))(body);
    if (parsed.isOk()) {
      await completeStatusIdempotency(c.env.DB, accountId, key, parsed.value.id);
    }
  } else {
    await releaseStatusIdempotency(c.env.DB, accountId, key);
  }
  return response;
});

/**
 * Who favourited or boosted a status (Mastodon's `favourited_by` and
 * `reblogged_by`). Public for public statuses; anything the requester may not
 * see answers 404 with the privacy-preserving wording Mastodon uses.
 */
