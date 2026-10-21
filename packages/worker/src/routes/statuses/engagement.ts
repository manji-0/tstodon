import type { LocalStatus as LocalStatusValue } from "@tstodon/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import { findAccountById } from "../../account-store";
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
import { mastodonAccountDocument, mastodonRemoteAccount } from "../../account-documents";
import { mastodonStatus, mastodonStatuses } from "../../local-status-documents";
import { listStatusFavouritedBy, listStatusRebloggedBy } from "../../status-interaction-store";
import { parseInstanceIdentity } from "../../runtime-config";
import { findRemoteActorByUri } from "../../remote-actor-store";
import { findStatusById, findStatusesByIds } from "../../status-store";
import { canViewStatus } from "../../visibility-guard";
import { listQuotingStatusIds, revokeStatusQuote } from "../../quote-store";

export const statusEngagementRoutes = new Hono<{ Bindings: Env }>();

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

statusEngagementRoutes.get("/api/v1/statuses/:id/favourited_by", (c) =>
  statusEngagementAccounts(c, "favourited_by"),
);
statusEngagementRoutes.get("/api/v1/statuses/:id/reblogged_by", (c) =>
  statusEngagementAccounts(c, "reblogged_by"),
);

/** Quotes of a status: accepted local quotes the viewer may see, newest first. */
statusEngagementRoutes.get("/api/v1/statuses/:id/quotes", async (c) => {
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
statusEngagementRoutes.post("/api/v1/statuses/:id/quotes/:quoting_status_id/revoke", async (c) => {
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
