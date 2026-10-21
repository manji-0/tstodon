import { Hono } from "hono";
import type { Context } from "hono";
import { findAccountById, findAccountByIdOrUsername } from "../../account-store";
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
import { mastodonAccountDocument } from "../../account-documents";
import { mastodonStatuses } from "../../local-status-documents";
import { parseInstanceIdentity } from "../../runtime-config";
import { listFollowers, listFollowing } from "../../social-store";
import { listAccountStatusesFiltered, listPinnedStatuses } from "../../status-store";
import { queryFlag } from "./credentials";
import { lookupAccountDocument } from "./lookup";

export const accountProfileRoutes = new Hono<{ Bindings: Env }>();

accountProfileRoutes.get("/api/v1/accounts/:id", async (c) => {
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
  }
});

accountProfileRoutes.get("/api/v1/accounts/:id/statuses", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const account = await findAccountByIdOrUsername(c.env.DB, c.req.param("id") ?? "");
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const statuses =
    c.req.query("pinned") === "true"
      ? await listPinnedStatuses(c.env.DB, account.value.id)
      : await listAccountStatusesFiltered(c.env.DB, account.value.id, {
          limit: queryLimit(c.req.query("limit")),
          excludeReplies: queryFlag(c.req.query("exclude_replies")),
          excludeReblogs: queryFlag(c.req.query("exclude_reblogs")),
          onlyMedia: queryFlag(c.req.query("only_media")),
          tagged: c.req.query("tagged"),
          cursor: {
            maxId: c.req.query("max_id"),
            sinceId: c.req.query("since_id"),
            minId: c.req.query("min_id"),
          },
        });
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
});

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
  const documents = [];
  for (const edge of edges.value) {
    const found = await findAccountById(c.env.DB, edge.accountId);
    if (found.isOk() && found.value) {
      documents.push(await mastodonAccountDocument(c.env, identity.value, found.value));
    }
  }
  // Follow row ids are not in the documents, so the Link header carries them.
  setPaginationLinks(
    c,
    edges.value.map((edge) => edge.id),
    limit,
    { prev: "since_id" },
  );
  return c.json(documents);
};

accountProfileRoutes.get("/api/v1/accounts/:id/followers", (c) => accountList(c, "followers"));
accountProfileRoutes.get("/api/v1/accounts/:id/following", (c) => accountList(c, "following"));
