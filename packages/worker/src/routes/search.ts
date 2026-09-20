import { Hono } from "hono";
import { searchAccounts } from "../account-store";
import { authenticate } from "../auth";
import { jsonAuthError, jsonRepositoryError, queryLimit } from "../http";
import { mastodonAccountDocument, mastodonStatuses } from "../mastodon";
import { parseInstanceIdentity } from "../runtime-config";
import { searchStatuses } from "../status-store";
import type { Context } from "hono";

export const searchRoutes = new Hono<{ Bindings: Env }>();

const search = async (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const query = (c.req.query("q") ?? "").trim();
  const type = c.req.query("type");
  const limit = queryLimit(c.req.query("limit"), 5);
  if (query.length === 0) {
    return c.json({ accounts: [], statuses: [], hashtags: [] });
  }
  const accountDocs = [];
  if (type !== "statuses" && type !== "hashtags") {
    const accounts = await searchAccounts(c.env.DB, query, limit);
    if (accounts.isErr()) {
      return jsonRepositoryError(c, accounts.error.message);
    }
    for (const account of accounts.value) {
      accountDocs.push(await mastodonAccountDocument(c.env, identity.value, account));
    }
  }
  const statusDocs =
    type === "accounts" || type === "hashtags"
      ? []
      : await (async () => {
          const statuses = await searchStatuses(c.env.DB, query, limit);
          if (statuses.isErr()) {
            return statuses;
          }
          return mastodonStatuses(c.env, identity.value, statuses.value, viewerId);
        })();
  if (!Array.isArray(statusDocs)) {
    return jsonRepositoryError(c, statusDocs.error.message);
  }
  const hashtags =
    type === "accounts" || type === "statuses"
      ? []
      : query.startsWith("#")
        ? [
            {
              name: query.replace(/^#/, ""),
              url: `https://${identity.value.domain}/tags/${query.replace(/^#/, "")}`,
              history: [],
            },
          ]
        : [];
  return c.json({
    accounts: accountDocs,
    statuses: statusDocs,
    hashtags,
  });
};

searchRoutes.get("/api/v1/search", (c) => search(c));
searchRoutes.get("/api/v2/search", (c) => search(c));
