import { Hostname } from "@tstodon/domain";
import { assertNever } from "@tstodon/core";
import type { Context } from "hono";
import { findAccountByIdOrUsername } from "../../account-store";
import { findAccountProfile } from "../../account-profile-store";
import { authenticate } from "../../auth";
import { attachFilteredToStatuses } from "../../filter-match";
import {
  jsonAuthError,
  jsonRepositoryError,
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
import { suspendedDomains } from "../../admin-domain-block-store";
import { RemoteAccountId } from "../../remote-account-id";
import { findRemoteActorByUri } from "../../remote-actor-store";
import { requestRemoteOutboxBackfill } from "../../remote-outbox-backfill";
import { relationshipFlags } from "../../relationship-store";
import {
  remoteAccountPinnedDocuments,
  remoteAccountTimelineDocuments,
} from "../../timeline-documents";
import { listPinnedStatuses } from "../../status-pin-store";
import { queryFlag } from "./credentials";
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
  switch (found.value.kind) {
    case "Found":
      return c.json(found.value.document);
    case "Suspended":
      return c.json({ error: "This account is suspended", kind: "AccountSuspended" }, 410);
    case "NotFound":
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    default:
      return assertNever(found.value);
  }
};

/**
 * A cached remote actor's statuses. As in Mastodon, the list is empty when the
 * viewer blocks the actor or its domain, or the instance suspends that domain.
 * `pinned=true` lists the notes of its `featured` collection. A view queues a
 * backfill of the actor's outbox and pins when it has not run lately; this
 * response shows what is cached already.
 */
const remoteAccountStatuses = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  viewerId: string | undefined,
  id: string,
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
  const hidden =
    blocks?.blocking === true ||
    blocks?.domainBlocking === true ||
    (await suspendedDomains(c.env.DB)).has(Hostname.ofAuthority(actor.value.domain));
  if (hidden) {
    return c.json([]);
  }
  await requestRemoteOutboxBackfill(c.env, actor.value.actorUri);
  const documents =
    c.req.query("pinned") === "true"
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
  const filters: AccountStatusFilters = {
    limit: queryLimit(c.req.query("limit")),
    excludeReplies: queryFlag(c.req.query("exclude_replies")),
    excludeReblogs: queryFlag(c.req.query("exclude_reblogs")),
    onlyMedia: queryFlag(c.req.query("only_media")),
    tagged: c.req.query("tagged"),
    cursor: queryCursor(c),
  };
  const account = await findAccountByIdOrUsername(c.env.DB, id);
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return remoteAccountStatuses(c, identity.value, viewerId, id, filters);
  }
  const statuses =
    c.req.query("pinned") === "true"
      ? await listPinnedStatuses(c.env.DB, account.value.id)
      : await listAccountStatusesFiltered(c.env.DB, account.value.id, filters);
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  return c.json(
    await attachFilteredToStatuses(
      c.env.DB,
      viewerId,
      "public",
      statuses.value,
      await mastodonStatuses(c.env, identity.value, statuses.value, viewerId),
    ),
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
  const limit = queryAccountsLimit(c.req.query("limit"));
  // `hide_collections` clears the lists for everyone but the account itself.
  if (!(await showsCollections(c, account.value.id))) {
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
  const documents = documentsInOrder(
    edges.value.map((edge) => edge.accountId),
    byId,
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
