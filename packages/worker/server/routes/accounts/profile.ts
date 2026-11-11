import { ApiGetAccountStatusesParamsSchema } from "@tstodon/api";
import { warmSchemas } from "@tstodon/core";
import { AccountPresentation } from "@tstodon/domain";
import type { Context } from "hono";
import { findAccountByIdOrUsername } from "../../account-store";
import { findAccountProfile } from "../../account-profile-store";
import { authenticate } from "../../auth";
import { attachFilteredToStatuses } from "../../filter-match";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryAccountsLimit,
  queryCursor,
  queryLimit,
  setPaginationLinks,
} from "../../http";
import { accountDocumentsByIds, documentsInOrder } from "../../account-documents";
import { mastodonStatuses } from "../../local-status-documents";
import { parseInstanceIdentity } from "../../runtime-config";
import { listFollowers, listFollowing } from "../../follow-store";
import {
  type AccountStatusFilters,
  listAccountStatusesFiltered,
} from "../../status-timeline-store";
import type { InstanceIdentity } from "@tstodon/domain";
import { accountRefPresentation } from "../../account-presentation";
import { localRef, remoteRef } from "../../account-ref";
import { RemoteAccountId } from "../../remote-account-id";
import { findRemoteActorByUri } from "../../remote-actor-store";
import { requestRemoteOutboxBackfill } from "../../remote-outbox-backfill";
import { relationshipFlags } from "../../relationship-store";
import {
  remoteAccountPinnedDocuments,
  remoteAccountTimelineDocuments,
} from "../../timeline-documents";
import { listPinnedStatuses } from "../../status-pin-store";
import { paramsCursor, readQueryParams } from "../../request-params";
import { lookupAccountDocument } from "./lookup";

export const getV1AccountsById = async (c: Context<{ Bindings: Env }, "/api/v1/accounts/:id">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const found = await lookupAccountDocument(c.env, identity.value, c.req.param("id") ?? "");
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  return found.value
    ? c.json(found.value)
    : c.json({ error: "Record not found", kind: "NotFound" }, 404);
};

/**
 * A cached remote actor's statuses. As in Mastodon, the list is empty when the
 * viewer blocks the actor or its domain, or the actor is not available.
 * `pinned=true` lists the notes of its `featured` collection. A view queues a
 * backfill of the actor's outbox and pins when it has not run lately; this
 * response shows what is cached already.
 */
const remoteAccountStatuses = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  viewerId: string | undefined,
  id: string,
  pinned: boolean,
  filters: AccountStatusFilters,
) => {
  const actorUri = RemoteAccountId.decode(id);
  if (actorUri.isErr()) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const actor = await findRemoteActorByUri(c.env.DB, actorUri.value);
  if (actor.isErr()) {
    return jsonRepositoryError(c, actor.error.message);
  }
  if (!actor.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const flags = viewerId ? await relationshipFlags(c.env.DB, viewerId, id) : undefined;
  if (flags !== undefined && flags.isErr()) {
    return jsonRepositoryError(c, flags.error.message);
  }
  const blocks = flags?.unwrapOr(undefined);
  if (blocks?.blocking === true || blocks?.domainBlocking === true) {
    return c.json([]);
  }
  const presentation = await accountRefPresentation(c.env, remoteRef(actor.value));
  if (presentation.isErr()) {
    return jsonRepositoryError(c, presentation.error.message);
  }
  if (!AccountPresentation.available(presentation.value)) {
    return c.json([]);
  }
  await requestRemoteOutboxBackfill(c.env, actor.value.actorUri);
  const documents = pinned
    ? await remoteAccountPinnedDocuments(c.env, identity, actor.value.actorUri, viewerId)
    : await remoteAccountTimelineDocuments(
        c.env,
        identity,
        actor.value.actorUri,
        viewerId,
        filters,
      );
  if (documents.isErr()) {
    return jsonRepositoryError(c, documents.error.message);
  }
  return c.json(documents.value);
};

export const getV1AccountsByIdStatuses = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/:id/statuses">,
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
  const id = c.req.param("id") ?? "";
  const params = readQueryParams(c, ApiGetAccountStatusesParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const pinned = params.value.pinned === true;
  const filters: AccountStatusFilters = {
    limit: queryLimit(params.value.limit),
    excludeReplies: params.value.exclude_replies === true,
    excludeReblogs: params.value.exclude_reblogs === true,
    excludeDirect: params.value.exclude_direct === true,
    onlyMedia: params.value.only_media === true,
    tagged: params.value.tagged,
    cursor: paramsCursor(params.value),
  };
  const account = await findAccountByIdOrUsername(c.env.DB, id);
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return remoteAccountStatuses(c, identity.value, viewerId, id, pinned, filters);
  }
  const presentation = await accountRefPresentation(c.env, localRef(identity.value, account.value));
  if (presentation.isErr()) {
    return jsonRepositoryError(c, presentation.error.message);
  }
  if (!AccountPresentation.available(presentation.value)) {
    return c.json([]);
  }
  const statuses = pinned
    ? await listPinnedStatuses(c.env.DB, account.value.id)
    : await listAccountStatusesFiltered(c.env.DB, account.value.id, filters);
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  const documents = await mastodonStatuses(c.env, identity.value, statuses.value, viewerId);
  if (documents.isErr()) {
    return jsonRepositoryError(c, documents.error.message);
  }
  return c.json(
    await attachFilteredToStatuses(c.env.DB, viewerId, "public", statuses.value, documents.value),
  );
};

/** True unless the account hides its collections from this viewer. */
const showsCollections = async (
  c: Context<{ Bindings: Env }>,
  accountId: string,
): Promise<boolean> => {
  const profile = await findAccountProfile(c.env.DB, accountId);
  if (profile.isErr() || !profile.value.hideCollections) {
    return true;
  }
  const auth = await authenticate(c.req.raw, c.env);
  const viewerId = auth.isOk() && auth.value.kind === "Account" ? auth.value.account.id : undefined;
  return viewerId === accountId;
};

const accountList = async (c: Context<{ Bindings: Env }>, kind: "followers" | "following") => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const account = await findAccountByIdOrUsername(c.env.DB, c.req.param("id") ?? "");
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const presentation = await accountRefPresentation(c.env, localRef(identity.value, account.value));
  if (presentation.isErr()) {
    return jsonRepositoryError(c, presentation.error.message);
  }
  const limit = queryAccountsLimit(c.req.query("limit"));
  // `hide_collections` clears the lists for everyone but the account itself.
  if (
    !AccountPresentation.available(presentation.value) ||
    !(await showsCollections(c, account.value.id))
  ) {
    return c.json([]);
  }
  const edges =
    kind === "followers"
      ? await listFollowers(c.env.DB, account.value.id, limit, queryCursor(c))
      : await listFollowing(c.env.DB, account.value.id, limit, queryCursor(c));
  if (edges.isErr()) {
    return jsonRepositoryError(c, edges.error.message);
  }
  const byId = await accountDocumentsByIds(
    c.env,
    identity.value,
    edges.value.map((edge) => edge.accountId),
  );
  if (byId.isErr()) {
    return jsonRepositoryError(c, byId.error.message);
  }
  const documents = documentsInOrder(
    edges.value.map((edge) => edge.accountId),
    byId.value,
  );
  // Follow row ids are not in the documents, so the Link header carries them.
  setPaginationLinks(
    c,
    edges.value.map((edge) => edge.id),
    limit,
    { prev: "since_id" },
  );
  return c.json(documents);
};

export const getV1AccountsByIdFollowers = (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/:id/followers">,
) => accountList(c, "followers");
export const getV1AccountsByIdFollowing = (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/:id/following">,
) => accountList(c, "following");

warmSchemas([ApiGetAccountStatusesParamsSchema]);
