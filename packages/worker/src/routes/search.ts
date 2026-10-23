import type { InstanceIdentity } from "@tstodon/domain";
import { searchAccounts } from "../account-store";
import type { LocalStatus as LocalStatusValue } from "@tstodon/domain";
import { authenticate } from "../auth";
import { filteredAttribute, loadViewerFilters, matchFilters } from "../filter-match";
import { jsonAuthError, jsonRepositoryError, queryLimit } from "../http";
import {
  documentsInOrder,
  mastodonAccountDocuments,
  mastodonRemoteAccount,
} from "../account-documents";
import { mastodonStatuses } from "../local-status-documents";
import { mastodonTag } from "../tag-documents";
import { elapsedMs, writeMetric } from "../metrics";
import { resolveRemoteActor, resolveRemoteActorByHandle } from "../remote-actor-fetch";
import { suspendedDomains } from "../admin-domain-block-store";
import { searchRemoteActors } from "../remote-actor-store";
import { federationAllowHosts, parseInstanceIdentity } from "../runtime-config";
import { searchStatuses } from "../status-timeline-store";
import { isTagFeatured, isTagFollowed, tagDailyHistory } from "../tag-store";
import type { Context } from "hono";

const resolveSearchAccount = async (
  env: Env,
  identity: InstanceIdentity,
  query: string,
): Promise<Record<string, unknown> | undefined> => {
  const bare = query.replace(/^@/, "").trim();
  const allowHosts = await federationAllowHosts(env);
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
    const rendered = await mastodonAccountDocuments(c.env, identity.value, accounts.value);
    accountDocs.push(
      ...documentsInOrder(
        accounts.value.map((account) => account.id),
        rendered,
      ),
    );
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
  const statusesById = new Map<string, LocalStatusValue>();
  const statusDocs =
    type === "accounts" || type === "hashtags"
      ? []
      : await (async () => {
          const statuses = await searchStatuses(c.env.DB, query, limit);
          if (statuses.isErr()) {
            return statuses;
          }
          for (const status of statuses.value) {
            statusesById.set(status.id, status);
          }
          return mastodonStatuses(c.env, identity.value, statuses.value, viewerId);
        })();
  if (!Array.isArray(statusDocs)) {
    return jsonRepositoryError(c, statusDocs.error.message);
  }
  // Mastodon reports which of the viewer's filters matched each result.
  if (viewerId) {
    const filters = await loadViewerFilters(c.env.DB, viewerId);
    if (filters.isOk() && filters.value.length > 0) {
      for (const document of statusDocs) {
        const id = typeof document.id === "string" ? document.id : "";
        const status = statusesById.get(id);
        const renderedContent = typeof document.content === "string" ? document.content : "";
        const text = status && status.kind === "LocalNote" ? status.text : renderedContent;
        const matches = matchFilters(filters.value, "public", text, id.length > 0 ? id : null);
        if (matches.length > 0) {
          document.filtered = filteredAttribute(matches);
        }
      }
    }
  }
  let hashtags: Record<string, unknown>[] = [];
  if (type !== "accounts" && type !== "statuses" && query.startsWith("#")) {
    const name = query.replace(/^#/, "").toLowerCase();
    const history = await tagDailyHistory(c.env.DB, name);
    const following = viewerId ? await isTagFollowed(c.env.DB, viewerId, name) : undefined;
    const featuring = viewerId ? await isTagFeatured(c.env.DB, viewerId, name) : undefined;
    hashtags = [
      mastodonTag(identity.value, name, {
        history: history.isOk() ? history.value : [],
        following: following?.unwrapOr(false) ?? false,
        featuring: featuring?.unwrapOr(false) ?? false,
      }),
    ];
  }
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

export const getV1Search = (c: Context<{ Bindings: Env }, "/api/v1/search">) => search(c);
export const getV2Search = (c: Context<{ Bindings: Env }, "/api/v2/search">) => search(c);
