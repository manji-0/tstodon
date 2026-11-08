import {
  InstanceIdentity,
  type LocalStatus,
  QuoteInteractionPolicy,
  type RemoteStatusValue,
  StatusId,
  StatusTarget,
  type StatusTargetValue,
  Visibility,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { findAccountById } from "./account-store";
import { escapeHtml, mentionUsernames, remoteMentionHandles } from "./html";
import { findFollowKind } from "./follow-store";
import { type FoundStatus, findStatusAnywhere, showsFoundStatus } from "./found-status";
import type { QuotedAuthor } from "./local-status-publish";
import { findRemoteActorByUri } from "./remote-actor-store";
import { quoteViewerRelations } from "./remote-status-documents";
import { findRemoteStatusById } from "./remote-status-store";
import { findStatusById } from "./status-store";
import { quotePolicyName } from "./quote-policy-name";
import { defaultQuotePolicy, findStatusQuotePolicy, type QuotePolicy } from "./quote-store";
import { ApiRefusal } from "./routes/api-refusal";

/** Public and unlisted statuses can be quoted by anyone their policy allows. */
export const visibilityIsPublic = (visibility: Visibility): boolean =>
  visibility.kind === "Public" || visibility.kind === "Unlisted";

/** Mastodon's `statuses.errors.quoted_status_not_found`. */
const quoteNotFound = ApiRefusal.rejected(
  404,
  "The post you are trying to quote does not appear to exist.",
  "NotFound",
);

/** The status a quote post points at, its author, and the link the post renders for it. */
export type QuoteTarget = Readonly<{
  quoted: StatusTargetValue;
  quotedAuthor: QuotedAuthor;
  inlineHtml: string | null;
}>;

/** A quote target and the visibility the quoting post ends up with. */
export type ResolvedQuote = Readonly<{ quote: QuoteTarget | null; visibility: Visibility }>;

/** Mastodon's `statuses.errors.quoted_user_not_mentioned`. */
const quotedAuthorNotMentioned = ApiRefusal.rejected(
  422,
  "Quoted status author must be mentioned in a direct quote",
  "QuoteNotAllowed",
);

const directNotQuotable = ApiRefusal.rejected(
  422,
  "Direct messages cannot be quoted",
  "QuoteNotAllowed",
);

/** The `quote-inline` paragraph, unless the text already links the quoted status. */
const quoteInlineHtml = (url: string, text: string): string | null =>
  url.length > 0 && !text.includes(url)
    ? `<p class="quote-inline">RE: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`
    : null;

/** The status `id` names, a boost unwrapped to what it boosts, as Mastodon quotes it. */
const findQuotable = async (
  db: D1Database,
  id: string,
): Promise<Result<FoundStatus | undefined, RepositoryError>> => {
  const found = await findStatusAnywhere(db, id);
  if (found.isErr() || found.value?.kind !== "LocalStatus") {
    return found;
  }
  const status = found.value.status;
  if (status.kind !== "LocalReblog") {
    return found;
  }
  return status.target.kind === "LocalStatus"
    ? (await findStatusById(db, status.target.statusId)).map(
        (original) => original && { kind: "LocalStatus", status: original },
      )
    : (await findRemoteStatusById(db, status.target.statusId)).map(
        (original) => original && { kind: "RemoteStatus", status: original },
      );
};

/**
 * Resolve `quoted_status_id`: a local or cached remote status shown to the
 * author that they may quote. A refusal by policy answers Mastodon's one 404,
 * as `set_quoted_status`; a status no one else may quote answers 422.
 */
export const resolveQuote = async (
  env: Env,
  identity: InstanceIdentity,
  authorId: string,
  quotedRaw: string,
  text: string,
  visibility: Visibility,
): Promise<Result<ResolvedQuote, ApiRefusal>> => {
  if (quotedRaw.length === 0) {
    return ok({ quote: null, visibility });
  }
  const quotedId = StatusId.parse(quotedRaw);
  if (quotedId.isErr()) {
    return err(ApiRefusal.rejected(422, "Invalid quoted_status_id", "ValidationError"));
  }
  const found = await findQuotable(env.DB, quotedId.value);
  if (found.isErr()) {
    return err(ApiRefusal.repository(found.error.message));
  }
  if (!found.value) {
    return err(quoteNotFound);
  }
  const shown = await showsFoundStatus(env, found.value, authorId);
  if (shown.isErr()) {
    return err(ApiRefusal.repository(shown.error.message));
  }
  if (!shown.value) {
    return err(quoteNotFound);
  }
  return found.value.kind === "LocalStatus"
    ? resolveLocalQuote(env, identity, authorId, found.value.status, text, visibility)
    : resolveRemoteQuote(env, identity, authorId, found.value.status, text, visibility);
};

/**
 * A local quoted status. Its policy is its stored policy (else its author's
 * default), and a followers-only original clamps the quote to followers-only
 * too, so the visibility the post ends up with comes back with the target.
 */
const resolveLocalQuote = async (
  env: Env,
  identity: InstanceIdentity,
  authorId: string,
  target: LocalStatus,
  text: string,
  visibility: Visibility,
): Promise<Result<ResolvedQuote, ApiRefusal>> => {
  const db = env.DB;
  const targetVisibility = Visibility.toMastodon(target.visibility);
  if (targetVisibility === "direct") {
    return err(directNotQuotable);
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
      return err(quotedAuthorNotMentioned);
    }
  }
  const url =
    targetAuthor.isOk() && targetAuthor.value
      ? `${InstanceIdentity.actorUrl(identity, targetAuthor.value.username)}/statuses/${target.id}`
      : "";
  return ok({
    quote: {
      quoted: StatusTarget.local(target.id),
      quotedAuthor: { kind: "Local", accountId: target.accountId },
      inlineHtml: quoteInlineHtml(url, text),
    },
    visibility: clamped,
  });
};

/**
 * A cached remote quoted status. As Mastodon's `Quote#validate_visibility`,
 * only a public or unlisted one can be quoted; its author's
 * `interactionPolicy.canQuote` decides who may ask (`StatusPolicy#quote?`).
 * Automatic, manual and unknown all go ahead as a pending quote: the author's
 * server answers the `QuoteRequest`.
 */
const resolveRemoteQuote = async (
  env: Env,
  identity: InstanceIdentity,
  authorId: string,
  target: RemoteStatusValue,
  text: string,
  visibility: Visibility,
): Promise<Result<ResolvedQuote, ApiRefusal>> => {
  if (target.visibility.kind === "Direct") {
    return err(directNotQuotable);
  }
  if (!visibilityIsPublic(target.visibility)) {
    return err(
      ApiRefusal.rejected(422, "Only public and unlisted posts can be quoted", "QuoteNotAllowed"),
    );
  }
  const actor = await findRemoteActorByUri(env.DB, target.actorUri);
  if (actor.isErr()) {
    return err(ApiRefusal.repository(actor.error.message));
  }
  if (!actor.value) {
    return err(quoteNotFound);
  }
  const relations = await quoteViewerRelations(env.DB, authorId, [target.actorUri]);
  const approval = QuoteInteractionPolicy.forViewer(
    target.quotePolicy,
    target.visibility,
    relations.get(target.actorUri),
  );
  if (approval === "denied") {
    return err(quoteNotFound);
  }
  const { username, domain } = actor.value;
  if (
    visibility.kind === "Direct" &&
    !remoteMentionHandles(text, identity.domain).some(
      (handle) =>
        handle.username.toLowerCase() === username.toLowerCase() &&
        handle.domain.toLowerCase() === domain.toLowerCase(),
    )
  ) {
    return err(quotedAuthorNotMentioned);
  }
  return ok({
    quote: {
      quoted: StatusTarget.remote(target.id),
      quotedAuthor: { kind: "Remote", actor: actor.value },
      inlineHtml: quoteInlineHtml(target.url ?? target.objectUri, text),
    },
    visibility,
  });
};
