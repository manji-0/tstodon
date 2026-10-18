import { Hono } from "hono";
import type { InstanceIdentity } from "@tstodon/domain";
import { searchAccounts } from "../account-store";
import { authenticate } from "../auth";
import { jsonAuthError, jsonRepositoryError, queryLimit } from "../http";
import { mastodonAccountDocument, mastodonRemoteAccount, mastodonStatuses } from "../mastodon";
import { elapsedMs, writeMetric } from "../metrics";
import { resolveRemoteActor, resolveRemoteActorByHandle } from "../remote-actor-fetch";
import { suspendedDomains } from "../admin-domain-block-store";
import { searchRemoteActors } from "../remote-actor-store";
import { federationAllowHosts, parseInstanceIdentity } from "../runtime-config";
import { searchStatuses } from "../status-store";
import type { Context } from "hono";

export const searchRoutes = new Hono<{ Bindings: Env }>();

const resolveSearchAccount = async (
  env: Env,
  identity: InstanceIdentity,
  query: string,
): Promise<Record<string, unknown> | undefined> => {
  const bare = query.replace(/^@/, "").trim();
  const allowHosts = federationAllowHosts(env);
  const blockedHosts = await suspendedDomains(env.DB);
  if (/^[^\s@]+@[^\s@]+$/.test(bare)) {
    const actor = await resolveRemoteActorByHandle(env.DB, identity, bare, {
      allowHosts,
      blockedHosts,
    });
    return actor.isOk() ? mastodonRemoteAccount(identity, actor.value) : undefined;
  }
  if (bare.startsWith("http://") || bare.startsWith("https://")) {
    const actor = await resolveRemoteActor(env.DB, identity, `${bare}#main-key`, bare, {
      allowHosts,
      blockedHosts,
    });
    return actor.isOk() ? mastodonRemoteAccount(identity, actor.value) : undefined;
  }
  return undefined;
};

const search = async (c: Context<{ Bindings: Env }>) => {
  const startedAt = Date.now();
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
  const type = c.req.query("type") ?? "all";
  const limit = queryLimit(c.req.query("limit"), 5);
  const resolveRaw = c.req.query("resolve");
  const resolve = resolveRaw === "true" || resolveRaw === "1";
  if (query.length === 0) {
    return c.json({ accounts: [], statuses: [], hashtags: [] });
  }
  const accountDocs: Record<string, unknown>[] = [];
  if (type !== "statuses" && type !== "hashtags") {
    const accounts = await searchAccounts(c.env.DB, query, limit);
    if (accounts.isErr()) {
      return jsonRepositoryError(c, accounts.error.message);
    }
    for (const account of accounts.value) {
      accountDocs.push(await mastodonAccountDocument(c.env, identity.value, account));
    }
    const seen = new Set(accountDocs.map((document) => String(document.id)));
    const remoteActors = await searchRemoteActors(c.env.DB, query.replace(/^@/, ""), limit);
    if (remoteActors.isErr()) {
      return jsonRepositoryError(c, remoteActors.error.message);
    }
    for (const actor of remoteActors.value) {
      const document = mastodonRemoteAccount(identity.value, actor);
      if (!seen.has(String(document.id))) {
        seen.add(String(document.id));
        accountDocs.push(document);
      }
    }
    if (resolve) {
      const resolved = await resolveSearchAccount(c.env, identity.value, query);
      if (resolved && !seen.has(String(resolved.id))) {
        seen.add(String(resolved.id));
        accountDocs.push(resolved);
      }
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
  // doubles: [latencyMs, accountHits, statusHits]
  writeMetric(
    c.env,
    "search",
    [elapsedMs(startedAt), accountDocs.length, statusDocs.length],
    [type],
  );
  return c.json({
    accounts: accountDocs,
    statuses: statusDocs,
    hashtags,
  });
};

searchRoutes.get("/api/v1/search", (c) => search(c));
searchRoutes.get("/api/v2/search", (c) => search(c));
