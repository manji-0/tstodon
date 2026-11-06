import { StatusAuthors } from "../../account-presentation";
import {
  type InstanceIdentity,
  type LocalAccount,
  type LocalStatus as LocalStatusValue,
  Quote,
  type RemoteStatusValue,
} from "@tstodon/domain";
import type { Context } from "hono";
import { authenticate } from "../../auth";
import {
  jsonAuthError,
  jsonRepositoryError,
  queryAccountsLimit,
  queryCursor,
  queryLimit,
  requireUser,
  setPaginationLinks,
} from "../../http";
import { availableAccountDocumentsByIds, documentsInOrder } from "../../account-documents";
import { mastodonStatus, mastodonStatuses } from "../../local-status-documents";
import { listStatusFavouritedBy, listStatusRebloggedBy } from "../../status-interaction-store";
import {
  findShownStatusAnywhere,
  findStatusAnywhere,
  type FoundStatus,
  foundStatusTarget,
} from "../../found-status";
import { documentsById } from "../../documents-by-id";
import { mastodonRemoteStatuses } from "../../remote-status-documents";
import { findRemoteStatusesByIds } from "../../remote-status-store";
import { parseInstanceIdentity } from "../../runtime-config";
import { RemoteAccountId } from "../../remote-account-id";
import { findStatusById, findStatusesByIds } from "../../status-store";
import { canViewRemoteStatus, canViewStatus } from "../../visibility-guard";
import { findQuoteByQuoting, listQuotingTargets, saveQuoteState } from "../../quote-store";
import { localNoteRef } from "../../activitypub";
import { enqueueActivityToInboxes } from "../../delivery";
import {
  quoteAuthorizationDeleteActivity,
  localQuoteAuthorization,
} from "../../quote-authorization-document";
import { statusTargetRef } from "../../quote-uri";
import { findRemoteActorByUri, listAcceptedRemoteFollowerInboxes } from "../../remote-actor-store";

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
  const status = await findShownStatusAnywhere(c.env, c.req.param("id") ?? "", viewerId);
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  if (!status.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const target = foundStatusTarget(status.value);
  const limit = queryAccountsLimit(c.req.query("limit"));
  const engaged =
    kind === "favourited_by"
      ? await listStatusFavouritedBy(c.env.DB, target, limit, queryCursor(c))
      : await listStatusRebloggedBy(c.env.DB, target, limit, queryCursor(c));
  if (engaged.isErr()) {
    return jsonRepositoryError(c, engaged.error.message);
  }
  const ids = engaged.value.map((booster) =>
    booster.kind === "Local" ? booster.accountId : RemoteAccountId.encode(booster.actorUri),
  );
  const resolved = await availableAccountDocumentsByIds(c.env, identity.value, ids);
  if (resolved.isErr()) {
    return jsonRepositoryError(c, resolved.error.message);
  }
  const documents = documentsInOrder(ids, resolved.value);
  // The documents are accounts; the engagement row ids live in the header.
  setPaginationLinks(
    c,
    engaged.value.map((booster) => booster.id),
    limit,
    { prev: "since_id" },
  );
  return c.json(documents);
};

export const getV1StatusesByIdFavouritedBy = (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/favourited_by">,
) => statusEngagementAccounts(c, "favourited_by");
export const getV1StatusesByIdRebloggedBy = (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/reblogged_by">,
) => statusEngagementAccounts(c, "reblogged_by");

/** Quotes of a status: accepted quotes, local or remote, the viewer may see, newest first. */
export const getV1StatusesByIdQuotes = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/quotes">,
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
  const status = await findShownStatusAnywhere(c.env, c.req.param("id") ?? "", viewerId);
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  if (!status.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const limit = queryLimit(c.req.query("limit"));
  const quoting = await listQuotingTargets(
    c.env.DB,
    foundStatusTarget(status.value),
    limit,
    queryCursor(c),
  );
  if (quoting.isErr()) {
    return jsonRepositoryError(c, quoting.error.message);
  }
  const idsOf = (kind: "LocalStatus" | "RemoteStatus") =>
    quoting.value.flatMap((target) => (target.kind === kind ? [target.statusId] : []));
  const [locals, remotes] = await Promise.all([
    findStatusesByIds(c.env.DB, idsOf("LocalStatus")),
    findRemoteStatusesByIds(c.env.DB, idsOf("RemoteStatus")),
  ]);
  if (locals.isErr()) {
    return jsonRepositoryError(c, locals.error.message);
  }
  if (remotes.isErr()) {
    return jsonRepositoryError(c, remotes.error.message);
  }
  const visibleLocals: LocalStatusValue[] = [];
  for (const local of locals.value.values()) {
    if (await canViewStatus(c.env.DB, local, viewerId)) {
      visibleLocals.push(local);
    }
  }
  const visibleRemotes: RemoteStatusValue[] = [];
  for (const remote of remotes.value.values()) {
    if (await canViewRemoteStatus(c.env.DB, remote, viewerId)) {
      visibleRemotes.push(remote);
    }
  }
  const [localDocuments, remoteDocuments] = await Promise.all([
    mastodonStatuses(c.env, identity.value, visibleLocals, viewerId),
    mastodonRemoteStatuses(c.env, identity.value, visibleRemotes, viewerId),
  ]);
  if (localDocuments.isErr()) {
    return jsonRepositoryError(c, localDocuments.error.message);
  }
  if (remoteDocuments.isErr()) {
    return jsonRepositoryError(c, remoteDocuments.error.message);
  }
  const quotingIds = quoting.value.map((target) => target.statusId);
  setPaginationLinks(c, quotingIds, limit, { prev: "since_id" });
  return c.json(
    documentsInOrder(
      quotingIds,
      documentsById([...localDocuments.value, ...remoteDocuments.value]),
    ),
  );
};

/**
 * Withdraw the stamp of a revoked quote, as Mastodon's `RevokeQuoteService`.
 * Mastodon sends the `Delete` to the reach of both statuses; this sends it to
 * the remote followers of each local author whose status is not direct, and
 * to the inbox of a remote quoting author, which is the part of that reach
 * stored here. Best effort: the revoke stands either way.
 */
const federateStampDeletion = async (
  env: Env,
  identity: InstanceIdentity,
  quotedAuthor: LocalAccount,
  quoted: LocalStatusValue,
  quoting: FoundStatus,
  quoteId: string,
): Promise<void> => {
  const target = localNoteRef(identity, quotedAuthor, quoted.id);
  const interacting = await statusTargetRef(env, identity, foundStatusTarget(quoting));
  if (!interacting) {
    return;
  }
  const audiences = [
    ...(quoted.visibility.kind === "Direct" ? [] : [quotedAuthor.id]),
    ...(quoting.kind === "LocalStatus" && quoting.status.visibility.kind !== "Direct"
      ? [quoting.status.accountId]
      : []),
  ];
  const inboxes: string[] = [];
  for (const accountId of new Set(audiences)) {
    const found = await listAcceptedRemoteFollowerInboxes(env.DB, accountId);
    inboxes.push(...(found.isOk() ? found.value : []));
  }
  if (quoting.kind === "RemoteStatus") {
    const author = await findRemoteActorByUri(env.DB, quoting.status.actorUri);
    inboxes.push(...(author.isOk() && author.value ? [author.value.inboxUri] : []));
  }
  const activity = quoteAuthorizationDeleteActivity(
    localQuoteAuthorization(target, quoteId, interacting.uri),
  );
  const enqueued = await enqueueActivityToInboxes(env, quotedAuthor.id, "Delete", activity, [
    ...new Set(inboxes),
  ]);
  if (enqueued.isErr()) {
    console.error(JSON.stringify({ kind: "QuoteStampDeleteNotFederated", quoteId }));
  }
};

/** The quoted author withdraws a quote; the quoting status stays, unattached. */
export const postV1StatusesByIdQuotesByQuotingStatusIdRevoke = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/quotes/:quoting_status_id/revoke">,
) => {
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
  const quoting = await findStatusAnywhere(c.env.DB, c.req.param("quoting_status_id") ?? "");
  if (quoting.isErr()) {
    return jsonRepositoryError(c, quoting.error.message);
  }
  if (!quoting.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const quote = await findQuoteByQuoting(c.env.DB, foundStatusTarget(quoting.value));
  if (quote.isErr()) {
    return jsonRepositoryError(c, quote.error.message);
  }
  const quotesThis =
    quote.value?.quoted.kind === "LocalStatus" && quote.value.quoted.statusId === quoted.value.id;
  const revoked = quote.value && quotesThis ? Quote.revoke(quote.value) : undefined;
  if (!revoked || revoked.isErr()) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const saved = await saveQuoteState(c.env.DB, revoked.value);
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  await federateStampDeletion(
    c.env,
    identity.value,
    user.value,
    quoted.value,
    quoting.value,
    revoked.value.id,
  );
  // As Mastodon, the quoting status answers whoever wrote it, a suspended author stripped.
  const document =
    quoting.value.kind === "LocalStatus"
      ? await mastodonStatus(
          c.env,
          identity.value,
          quoting.value.status,
          user.value.id,
          StatusAuthors.existing,
        )
      : (
          await mastodonRemoteStatuses(
            c.env,
            identity.value,
            [quoting.value.status],
            user.value.id,
            StatusAuthors.existing,
          )
        ).map((documents) => documents[0]);
  if (document.isErr()) {
    return jsonRepositoryError(c, document.error.message);
  }
  return document.value
    ? c.json(document.value)
    : c.json({ error: "Record not found", kind: "NotFound" }, 404);
};

/** Renders a local or remote status the viewer may see, or `null` when it is hidden or gone. */
