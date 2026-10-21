import {
  InstanceIdentity,
  LocalStatus,
  StatusComposition,
  StatusId,
  Visibility,
  reblogVisibility,
  type LocalStatus as LocalStatusValue,
  type QuoteApprovalPolicy,
  type StatusIdValue,
} from "@tstodon/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import { findAccountById, findAccountsByUsernames, findComposeDefaults } from "../account-store";
import { authenticate } from "../auth";
import { noteDocument } from "../activitypub";
import { nowInstant, nowIso } from "../clock";
import { enqueueLocalActivity } from "../delivery";
import { escapeHtml, mentionUsernames, textToHtml } from "../html";
import { replaceStatusMentions, replaceStatusRemoteMentions } from "../mention-store";
import { loadNoteMentions, resolveRemoteMentions } from "../mention-resolve";
import { findFollowKind } from "../social-store";
import { quotedStatusUri } from "../quote-uri";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryAccountsLimit,
  queryCursor,
  queryLimit,
  setPaginationLinks,
  readOptionalBody,
  readUnknownBody,
  requireUser,
} from "../http";
import { newEntityId } from "../ids";
import {
  mastodonAccountDocument,
  mastodonMedia,
  mastodonRemoteAccount,
  mastodonRemoteStatus,
  mastodonStatus,
  mastodonStatuses,
} from "../mastodon";
import { countPollVotes, findPollByStatusId, replacePollOptions } from "../poll-store";
import { listStatusFavouritedBy, listStatusRebloggedBy } from "../social-store";
import {
  CreateStatusBodySchema,
  ReblogBodySchema,
  isTruthy,
  mediaAttributesFromForm,
  stringList,
} from "../schemas";
import { z } from "zod";
import {
  completeStatusIdempotency,
  findStatusIdempotency,
  releaseStatusIdempotency,
  reserveStatusIdempotency,
} from "../status-idempotency-store";
import { InstanceLimits, characterCount } from "@tstodon/core";
import { schemaResult } from "@tstodon/core";
import type { MediaAttribute } from "../schemas";
import { parseInstanceIdentity } from "../runtime-config";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "../d1";
import { findRemoteActorByUri, findRemoteActorsByUris } from "../remote-actor-store";
import { findRemoteStatusById, findRemoteStatusesByIds } from "../remote-status-store";
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
  findLocalReblog,
  findStatusById,
  findStatusesByIds,
  findStatusUpdatedAt,
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
import { enqueueLinkCard } from "../link-card";
import {
  findMediaById,
  findMediaByIds,
  parseMediaFocus,
  updateMediaMetadata,
} from "../media-store";
import {
  muteStatusThread,
  resolveThreadRootStatusIds,
  unmuteStatusThread,
} from "../status-mute-store";
import { canViewRemoteStatus, canViewStatus } from "../visibility-guard";
import { publishLocalNote } from "../local-status-publish";
import {
  defaultQuotePolicy,
  findStatusQuotePolicy,
  isQuotePolicy,
  listAcceptedQuoteEdges,
  listQuotingStatusIds,
  setStatusQuotePolicy,
  revokeStatusQuote,
  type QuotePolicy,
} from "../quote-store";
import {
  MIN_SCHEDULE_OFFSET_MS,
  insertScheduledStatus,
  scheduledStatusDocument,
} from "../scheduled-status-store";

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

/** Queue the link preview for a status; the request never waits on it. */
const queueLinkCard = async (env: Env, statusId: string, text: string): Promise<void> => {
  const queued = await enqueueLinkCard(env, "Status", statusId, text);
  void queued;
};

/** The account-level default policy as its API name. */
const quotePolicyName = (policy: QuoteApprovalPolicy): QuotePolicy => {
  switch (policy.kind) {
    case "Public":
      return "public";
    case "Followers":
      return "followers";
    default:
      return "nobody";
  }
};

/** Public and unlisted statuses can be quoted by anyone their policy allows. */
const visibilityIsPublic = (visibility: Visibility): boolean =>
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
  if (policyRaw.length > 0 && !isQuotePolicy(policyRaw)) {
    return c.json({ error: "Invalid quote_approval_policy", kind: "ValidationError" }, 422);
  }
  // Direct and followers-only posts are never quotable by anyone else.
  const statusQuotePolicy: QuotePolicy = visibilityIsPublic(draft.value.visibility)
    ? policyRaw.length > 0
      ? (policyRaw as QuotePolicy)
      : quotePolicyName(user.value.defaultQuotePolicy)
    : "nobody";
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
        in_reply_to_id: inReplyToId === null ? null : inReplyToId,
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
    inReplyToId,
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
statusRoutes.post("/api/v1/statuses", async (c) => {
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
const statusEngagementAccounts = async (
  c: Context<{ Bindings: Env }>,
  kind: "favourited_by" | "reblogged_by",
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
  if (!status.value || !(await canViewStatus(c.env.DB, status.value, viewerId))) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const limit = queryAccountsLimit(c.req.query("limit"));
  const engaged =
    kind === "favourited_by"
      ? await listStatusFavouritedBy(c.env.DB, status.value.id, limit, queryCursor(c))
      : await listStatusRebloggedBy(c.env.DB, status.value.id, limit, queryCursor(c));
  if (engaged.isErr()) {
    return jsonRepositoryError(c, engaged.error.message);
  }
  const documents = [];
  for (const booster of engaged.value) {
    if (booster.kind === "Local") {
      const account = await findAccountById(c.env.DB, booster.accountId);
      if (account.isOk() && account.value) {
        documents.push(await mastodonAccountDocument(c.env, identity.value, account.value));
      }
      continue;
    }
    const actor = await findRemoteActorByUri(c.env.DB, booster.actorUri);
    if (actor.isOk() && actor.value) {
      documents.push(mastodonRemoteAccount(identity.value, actor.value));
    }
  }
  // The documents are accounts; the engagement row ids live in the header.
  setPaginationLinks(
    c,
    engaged.value.map((booster) => booster.id),
    limit,
    { prev: "since_id" },
  );
  return c.json(documents);
};

statusRoutes.get("/api/v1/statuses/:id/favourited_by", (c) =>
  statusEngagementAccounts(c, "favourited_by"),
);
statusRoutes.get("/api/v1/statuses/:id/reblogged_by", (c) =>
  statusEngagementAccounts(c, "reblogged_by"),
);

/** Quotes of a status: accepted local quotes the viewer may see, newest first. */
statusRoutes.get("/api/v1/statuses/:id/quotes", async (c) => {
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
  if (!status.value || !(await canViewStatus(c.env.DB, status.value, viewerId))) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const limit = queryLimit(c.req.query("limit"));
  const quotingIds = await listQuotingStatusIds(c.env.DB, status.value.id, limit, queryCursor(c));
  if (quotingIds.isErr()) {
    return jsonRepositoryError(c, quotingIds.error.message);
  }
  const loaded = await findStatusesByIds(c.env.DB, quotingIds.value);
  if (loaded.isErr()) {
    return jsonRepositoryError(c, loaded.error.message);
  }
  const visible: LocalStatusValue[] = [];
  for (const id of quotingIds.value) {
    const quoting = loaded.value.get(id);
    if (quoting && (await canViewStatus(c.env.DB, quoting, viewerId))) {
      visible.push(quoting);
    }
  }
  setPaginationLinks(c, quotingIds.value, limit, { prev: "since_id" });
  return c.json(await mastodonStatuses(c.env, identity.value, visible, viewerId));
});

/** The quoted author withdraws a quote; the quoting status stays, unattached. */
statusRoutes.post("/api/v1/statuses/:id/quotes/:quoting_status_id/revoke", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const quoted = await findStatusById(c.env.DB, c.req.param("id") ?? "");
  if (quoted.isErr()) {
    return jsonRepositoryError(c, quoted.error.message);
  }
  if (!quoted.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (quoted.value.accountId !== user.value.id) {
    return c.json({ error: "This action is not allowed", kind: "Forbidden" }, 403);
  }
  const quoting = await findStatusById(c.env.DB, c.req.param("quoting_status_id") ?? "");
  if (quoting.isErr()) {
    return jsonRepositoryError(c, quoting.error.message);
  }
  if (!quoting.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const revoked = await revokeStatusQuote(c.env.DB, quoted.value.id, quoting.value.id);
  if (revoked.isErr()) {
    return jsonRepositoryError(c, revoked.error.message);
  }
  if (!revoked.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json((await mastodonStatus(c.env, identity.value, quoting.value, user.value.id)) ?? {});
});

/** Renders a local or remote status the viewer may see, or `null` when it is hidden or gone. */
const visibleStatusDocument = async (
  env: Env,
  identity: InstanceIdentity,
  id: string,
  viewerId: string | undefined,
): Promise<Result<Record<string, unknown> | null, RepositoryError>> => {
  const status = await findStatusById(env.DB, id);
  if (status.isErr()) {
    return err(status.error);
  }
  if (!status.value) {
    const remote = await findRemoteStatusById(env.DB, id);
    if (remote.isErr()) {
      return err(remote.error);
    }
    if (!remote.value || !(await canViewRemoteStatus(env.DB, remote.value, viewerId))) {
      return ok(null);
    }
    const actor = await findRemoteActorByUri(env.DB, remote.value.actorUri);
    if (actor.isErr()) {
      return err(actor.error);
    }
    return ok(actor.value ? mastodonRemoteStatus(identity, remote.value, actor.value) : null);
  }
  if (!(await canViewStatus(env.DB, status.value, viewerId))) {
    return ok(null);
  }
  return ok((await mastodonStatus(env, identity, status.value, viewerId)) ?? null);
};

/** Mastodon caps `GET /api/v1/statuses?id[]=` at 20 ids. */
const MULTIPLE_STATUSES_LIMIT = 20;

statusRoutes.get("/api/v1/statuses", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const url = new URL(c.req.url);
  const ids = [
    ...new Set(
      [...url.searchParams.getAll("id[]"), ...url.searchParams.getAll("id")].filter(
        (id) => id.length > 0,
      ),
    ),
  ].slice(0, MULTIPLE_STATUSES_LIMIT);
  // Local and remote statuses each load in one query; missing or hidden ones
  // are left out rather than failing the batch.
  const [locals, remotes] = await Promise.all([
    findStatusesByIds(c.env.DB, ids),
    findRemoteStatusesByIds(c.env.DB, ids),
  ]);
  if (locals.isErr()) {
    return jsonRepositoryError(c, locals.error.message);
  }
  if (remotes.isErr()) {
    return jsonRepositoryError(c, remotes.error.message);
  }
  // Public and unlisted statuses pass without a query; only restricted ones look further.
  const visibleLocals = (
    await Promise.all(
      [...locals.value.values()].map(async (status) =>
        (await canViewStatus(c.env.DB, status, viewerId)) ? [status] : [],
      ),
    )
  ).flat();
  const visibleRemotes = (
    await Promise.all(
      [...remotes.value.values()].map(async (status) =>
        (await canViewRemoteStatus(c.env.DB, status, viewerId)) ? [status] : [],
      ),
    )
  ).flat();
  const [localDocuments, actors] = await Promise.all([
    mastodonStatuses(c.env, identity.value, visibleLocals, viewerId),
    findRemoteActorsByUris(
      c.env.DB,
      visibleRemotes.map((status) => status.actorUri),
    ),
  ]);
  if (actors.isErr()) {
    return jsonRepositoryError(c, actors.error.message);
  }
  const documents = new Map<string, Record<string, unknown>>();
  for (const document of localDocuments) {
    if (typeof document.id === "string") {
      documents.set(document.id, document);
    }
  }
  for (const status of visibleRemotes) {
    const actor = actors.value.get(status.actorUri);
    if (actor) {
      documents.set(status.id, mastodonRemoteStatus(identity.value, status, actor));
    }
  }
  return c.json(ids.flatMap((id) => documents.get(id) ?? []));
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
  const document = await visibleStatusDocument(c.env, identity.value, c.req.param("id"), viewerId);
  if (document.isErr()) {
    return jsonRepositoryError(c, document.error.message);
  }
  if (!document.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(document.value);
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
      visibilityIsPublic(revised.visibility) ? (policyEdit as QuotePolicy) : "nobody",
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
          object: noteDocument(
            identity.value,
            user.value,
            revised,
            quoteUri,
            await loadNoteMentions(c.env.DB, identity.value, existing.id),
          ),
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
  const body = await readOptionalBody(c, ReblogBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const found = await findStatusById(c.env.DB, c.req.param("id") ?? "");
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  // Boosting a boost shares the underlying status, as Mastodon does.
  let target = found.value;
  for (let depth = 0; target.kind === "LocalReblog" && depth < 5; depth += 1) {
    const original = await findStatusById(c.env.DB, target.reblogOfId);
    if (original.isErr()) {
      return jsonRepositoryError(c, original.error.message);
    }
    if (!original.value) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    target = original.value;
  }
  // Mastodon's `StatusPolicy#reblog?`: never a direct status, never someone
  // else's followers-only post, and never one the viewer cannot see.
  const rebloggable =
    target.kind === "LocalNote" &&
    target.visibility.kind !== "Direct" &&
    (target.visibility.kind !== "FollowersOnly" || target.accountId === user.value.id) &&
    (await canViewStatus(c.env.DB, target, user.value.id));
  if (!rebloggable) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const existing = await findLocalReblog(c.env.DB, user.value.id, target.id);
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  if (existing.value) {
    // Mastodon answers the boost it already has rather than stacking another.
    const document = await findStatusById(c.env.DB, existing.value);
    if (document.isErr() || !document.value) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    return c.json(await mastodonStatus(c.env, identity.value, document.value, user.value.id));
  }
  const requested = body.value.visibility;
  let requestedVisibility: Visibility | undefined;
  if (requested !== undefined && requested.length > 0) {
    const parsed = Visibility.fromMastodon(requested);
    // A boost may not be direct (Mastodon excludes it for reblogs).
    if (parsed.isErr() || parsed.value.kind === "Direct") {
      return c.json({ error: "Invalid visibility", kind: "Unknown" }, 400);
    }
    requestedVisibility = parsed.value;
  }
  const reblogId = StatusId.parse(newEntityId());
  if (reblogId.isErr()) {
    return jsonRepositoryError(c, "invalid status id");
  }
  const reblog = LocalStatus.reblog(
    reblogId.value,
    user.value.id,
    target.id,
    nowInstant(),
    reblogVisibility(target.visibility, requestedVisibility, user.value.defaultPostVisibility),
  );
  const inserted = await insertLocalReblog(c.env.DB, reblog);
  if (inserted.isErr()) {
    return jsonRepositoryError(c, inserted.error.message);
  }
  if (target.accountId !== user.value.id) {
    await notifyAccount(c.env, {
      accountId: target.accountId,
      fromAccountId: user.value.id,
      kind: "reblog",
      statusId: target.id,
    });
  }
  const actor = InstanceIdentity.actorUrl(identity.value, user.value.username);
  const enqueued = await enqueueLocalActivity(c.env, user.value.id, "Announce", {
    type: "Announce",
    actor,
    object: `${actor}/statuses/${target.id}`,
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
  const limit = queryLimit(c.req.query("limit"));
  const statuses = await listFavouritedStatuses(c.env.DB, user.value.id, limit, queryCursor(c));
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  setPaginationLinks(
    c,
    statuses.value.map((status) => status.id),
    limit,
  );
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
  const limit = queryLimit(c.req.query("limit"));
  const statuses = await listBookmarkedStatuses(c.env.DB, user.value.id, limit, queryCursor(c));
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  setPaginationLinks(
    c,
    statuses.value.map((status) => status.id),
    limit,
  );
  return c.json(await mastodonStatuses(c.env, identity.value, statuses.value, user.value.id));
});

/**
 * Translation has no backend in this deployment, so an eligible status answers
 * 503 the same way Mastodon does when the translation request fails. Statuses
 * that Mastodon would not translate (private mentions and followers-only posts)
 * are refused with 403 before that.
 */
statusRoutes.post("/api/v1/statuses/:id/translate", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const status = await findStatusById(c.env.DB, c.req.param("id") ?? "");
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  if (!status.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  let translatable: LocalStatusValue | undefined;
  if (status.value.kind === "LocalNote") {
    translatable = status.value;
  } else {
    const target = await findStatusById(c.env.DB, status.value.reblogOfId);
    if (target.isErr()) {
      return jsonRepositoryError(c, target.error.message);
    }
    translatable = target.value;
  }
  const visibility = translatable?.kind === "LocalNote" ? translatable.visibility.kind : undefined;
  if (visibility !== "Public" && visibility !== "Unlisted") {
    return c.json({ error: "This action is not allowed", kind: "Forbidden" }, 403);
  }
  return c.json({ error: "Service Unavailable", kind: "TranslationUnavailable" }, 503);
});
