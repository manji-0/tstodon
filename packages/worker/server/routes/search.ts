import type { ApiAccountJSON, ApiHashtagJSON, ApiSearchResultsJSON } from "@tstodon/api";
import { ok } from "neverthrow";
import type { InstanceIdentity, RemoteActor } from "@tstodon/domain";
import { searchAccountsPage } from "../account-search";
import type { LocalStatus as LocalStatusValue } from "@tstodon/domain";
import { authenticate } from "../auth";
import { filteredAttribute, loadViewerFilters, matchFilters } from "../filter-match";
import { isTruthy } from "../form-values";
import { jsonAuthError, jsonRepositoryError, queryLimit, queryOffset } from "../http";
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
import { searchableRemoteActors } from "../account-presentation";
import { federationAllowHosts, parseInstanceIdentity } from "../runtime-config";
import { searchStatuses } from "../status-timeline-store";
import { listFeaturedTags, listFollowedTags, searchTags, tagDailyHistories } from "../tag-store";
import type { Context } from "hono";

/** The remote actor a `resolve=true` query names by handle or actor URL, fetched if not cached. */
const resolveSearchActor = async (
  env: Env,
  identity: InstanceIdentity,
  query: string,
): Promise<RemoteActor | undefined> => {
  const bare = query.replace(/^@/, "").trim();
  const allowHosts = await federationAllowHosts(env);
  const blockedHosts = await suspendedDomains(env.DB);
  if (/^[^\s@]+@[^\s@]+$/.test(bare)) {
    const actor = await resolveRemoteActorByHandle(env.DB, identity, bare, {
      allowHosts,
      blockedHosts,
    });
    return actor.isOk() ? actor.value : undefined;
  }
  if (bare.startsWith("http://") || bare.startsWith("https://")) {
    const actor = await resolveRemoteActor(env.DB, identity, `${bare}#main-key`, bare, {
      allowHosts,
      blockedHosts,
    });
    return actor.isOk() ? actor.value : undefined;
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
  // Mastodon's `blank?`: an empty `type` is no type.
  const requestedType = (c.req.query("type") ?? "").trim();
  const type = requestedType.length === 0 ? "all" : requestedType;
  const limit = queryLimit(c.req.query("limit"), 5);
  const rawOffset = (c.req.query("offset") ?? "").trim();
  if (rawOffset.length > 0 && viewerId === undefined) {
    return c.json(
      { error: "Search queries pagination is not supported without authentication" },
      401,
    );
  }
  const resolve = isTruthy(c.req.query("resolve"));
  // Resolving makes this instance fetch from other servers on the caller's behalf.
  if (resolve && viewerId === undefined) {
    return c.json(
      {
        error:
          "Search queries that resolve remote resources are not supported without authentication",
      },
      401,
    );
  }
  // Mastodon pages by `offset` only when one result `type` is asked for.
  const offset = requestedType.length === 0 ? 0 : queryOffset(rawOffset);
  if (query.length === 0) {
    return c.json({ accounts: [], statuses: [], hashtags: [], collections: [] });
  }
  const accountDocs: ApiAccountJSON[] = [];
  if (type !== "statuses" && type !== "hashtags") {
    // As Mastodon, the resolved account joins only the first page, first,
    // and counts inside `limit`.
    const resolved =
      resolve && offset === 0 ? await resolveSearchActor(c.env, identity.value, query) : undefined;
    const exact = await searchableRemoteActors(c.env, resolved ? [resolved] : []);
    if (exact.isErr()) {
      return jsonRepositoryError(c, exact.error.message);
    }
    const page = await searchAccountsPage(
      c.env,
      { localTerms: query, remoteTerms: query.replace(/^@/, ""), scope: { kind: "Everyone" } },
      limit - exact.value.length,
      offset,
    );
    if (page.isErr()) {
      return jsonRepositoryError(c, page.error.message);
    }
    const rendered = await mastodonAccountDocuments(c.env, identity.value, page.value.local);
    const seen = new Set<string>();
    for (const document of [
      ...exact.value.map((actor) => mastodonRemoteAccount(identity.value, actor)),
      ...documentsInOrder(
        page.value.local.map((account) => account.id),
        rendered,
      ),
      ...page.value.remote.map((actor) => mastodonRemoteAccount(identity.value, actor)),
    ]) {
      const id = String(document.id);
      if (!seen.has(id)) {
        seen.add(id);
        accountDocs.push(document);
      }
    }
  }
  const statusesById = new Map<string, LocalStatusValue>();
  const rendered =
    type === "accounts" || type === "hashtags"
      ? ok([])
      : await (async () => {
          const statuses = await searchStatuses(c.env.DB, viewerId, query, limit, offset);
          if (statuses.isErr()) {
            return statuses;
          }
          for (const status of statuses.value) {
            statusesById.set(status.id, status);
          }
          return mastodonStatuses(c.env, identity.value, statuses.value, viewerId);
        })();
  if (rendered.isErr()) {
    return jsonRepositoryError(c, rendered.error.message);
  }
  const statusDocs = rendered.value;
  // Mastodon reports which of the viewer's filters matched each result.
  if (viewerId) {
    const filters = await loadViewerFilters(c.env.DB, viewerId);
    if (filters.isOk() && filters.value.length > 0) {
      for (const document of statusDocs) {
        const id = document.id;
        const status = statusesById.get(id);
        const text = status && status.kind === "LocalNote" ? status.text : document.content;
        const matches = matchFilters(filters.value, "public", text, id.length > 0 ? id : null);
        if (matches.length > 0) {
          document.filtered = filteredAttribute(matches);
        }
      }
    }
  }
  let hashtags: ApiHashtagJSON[] = [];
  if (type !== "accounts" && type !== "statuses") {
    const found = await searchTags(c.env.DB, query, limit, offset);
    if (found.isErr()) {
      return jsonRepositoryError(c, found.error.message);
    }
    const histories = await tagDailyHistories(c.env.DB, found.value);
    if (histories.isErr()) {
      return jsonRepositoryError(c, histories.error.message);
    }
    const viewerTags = viewerId !== undefined && found.value.length > 0;
    const followed = viewerTags ? await listFollowedTags(c.env.DB, viewerId) : ok([]);
    if (followed.isErr()) {
      return jsonRepositoryError(c, followed.error.message);
    }
    const featured = viewerTags ? await listFeaturedTags(c.env.DB, viewerId) : ok([]);
    if (featured.isErr()) {
      return jsonRepositoryError(c, featured.error.message);
    }
    const following = new Set(followed.value);
    const featuring = new Set(featured.value);
    hashtags = found.value.map((name) =>
      mastodonTag(identity.value, name, {
        history: histories.value.get(name) ?? [],
        following: following.has(name),
        featuring: featuring.has(name),
      }),
    );
  }
  // doubles: [latencyMs, accountHits, statusHits]
  writeMetric(
    c.env,
    "search",
    [elapsedMs(startedAt), accountDocs.length, statusDocs.length],
    [type],
  );
  const results: ApiSearchResultsJSON = {
    accounts: accountDocs,
    // Mastodon 4.7 also searches collections, which are not kept here; its
    // web UI expects the key.
    collections: [],
    statuses: statusDocs,
    hashtags,
  };
  return c.json(results);
};

export const getV1Search = (c: Context<{ Bindings: Env }, "/api/v1/search">) => search(c);
export const getV2Search = (c: Context<{ Bindings: Env }, "/api/v2/search">) => search(c);
