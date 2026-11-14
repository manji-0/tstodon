import type { ApiAccountJSON, ApiHashtagJSON, ApiSearchResultsJSON } from "@tstodon/api";
import { ApiSearchParamsSchema } from "@tstodon/api";
import { ok } from "neverthrow";
import type { InstanceIdentity, RemoteActor } from "@tstodon/domain";
import { searchAccountsPage } from "../account-search";
import type { LocalStatus as LocalStatusValue } from "@tstodon/domain";
import { authenticate } from "../auth";
import { filteredAttribute, loadViewerFilters, matchFilters } from "../filter-match";
import { readQueryParams } from "../request-params";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryLimit,
  queryOffset,
} from "../http";
import {
  documentsInOrder,
  mastodonAccountDocuments,
  mastodonRemoteAccount,
} from "../account-documents";
import { mastodonStatuses } from "../local-status-documents";
import { mastodonRemoteStatuses } from "../remote-status-documents";
import { isUrlQuery, localHandleUsername, resolveSearchUrl } from "../search-url";
import { mastodonTag } from "../tag-documents";
import { elapsedMs, writeMetric } from "../metrics";
import { resolveRemoteActorByHandle } from "../remote-actor-fetch";
import { findAccountByUsername } from "../account-store";
import type { FederatedFetchOptions } from "../federated-fetch";
import { suspendedDomains } from "../admin-domain-block-store";
import { searchableLocalAccounts, searchableRemoteActors } from "../account-presentation";
import { federationAllowHosts, parseInstanceIdentity } from "../runtime-config";
import { searchStatuses } from "../status-timeline-store";
import { listFeaturedTags, listFollowedTags, searchTags, tagDailyHistories } from "../tag-store";
import type { Context } from "hono";
import { instanceActorFetchSigner } from "../instance-actor";

/** The remote actor a `resolve=true` query names by its `user@domain` handle, fetched if not cached. */
const resolveSearchHandle = async (
  env: Env,
  identity: InstanceIdentity,
  query: string,
  options: FederatedFetchOptions,
): Promise<RemoteActor | undefined> => {
  const bare = query.replace(/^@/, "").trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(bare)) {
    return undefined;
  }
  const actor = await resolveRemoteActorByHandle(env.DB, identity, bare, options);
  return actor.isOk() ? actor.value : undefined;
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
  const params = readQueryParams(c, ApiSearchParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const query = (params.value.q ?? "").trim();
  // Mastodon's `blank?`: an empty `type` is no type.
  const requestedType = (params.value.type ?? "").trim();
  const type = requestedType.length === 0 ? "all" : requestedType;
  const limit = queryLimit(params.value.limit, 5);
  if (params.value.offset !== undefined && viewerId === undefined) {
    return c.json(
      { error: "Search queries pagination is not supported without authentication" },
      401,
    );
  }
  const resolve = params.value.resolve ?? false;
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
  const offset = requestedType.length === 0 ? 0 : queryOffset(params.value.offset);
  if (query.length === 0) {
    return c.json({ accounts: [], statuses: [], hashtags: [], collections: [] });
  }
  const fetchOptions = async (): Promise<FederatedFetchOptions> => ({
    allowHosts: await federationAllowHosts(c.env),
    blockedHosts: await suspendedDomains(c.env.DB),
    fetchSigner: instanceActorFetchSigner(c.env.DB, identity.value),
  });
  // As Mastodon's `SearchService`, a URL with `resolve=true` is looked up, not
  // searched for as text: the answer is the one status or account it names,
  // on the first page, and nothing else. It is looked up once whatever `type`
  // asks for, and a resource of another type is left out.
  const urlLookup = resolve && isUrlQuery(query);
  const urlResource =
    urlLookup && offset === 0
      ? await resolveSearchUrl(c.env, identity.value, query, viewerId, await fetchOptions())
      : ok(undefined);
  if (urlResource.isErr()) {
    return jsonRepositoryError(c, urlResource.error.message);
  }
  const named = urlResource.value;
  const accountDocs: ApiAccountJSON[] = [];
  if (type !== "statuses" && type !== "hashtags") {
    // `user@this-domain` names a local account: it is never looked up remotely.
    const localUsername = urlLookup ? undefined : localHandleUsername(identity.value, query);
    const localExact =
      named?.kind === "LocalAccount"
        ? ok(named.account)
        : localUsername !== undefined && offset === 0
          ? await findAccountByUsername(c.env.DB, localUsername)
          : ok(undefined);
    if (localExact.isErr()) {
      return jsonRepositoryError(c, localExact.error.message);
    }
    const exactLocal = await searchableLocalAccounts(
      c.env.DB,
      localExact.value ? [localExact.value] : [],
    );
    if (exactLocal.isErr()) {
      return jsonRepositoryError(c, exactLocal.error.message);
    }
    // As Mastodon, the resolved account joins only the first page, first,
    // and counts inside `limit`.
    const resolved =
      named?.kind === "RemoteAccount"
        ? named.actor
        : resolve && offset === 0 && !urlLookup && localUsername === undefined
          ? await resolveSearchHandle(c.env, identity.value, query, await fetchOptions())
          : undefined;
    const exact = await searchableRemoteActors(c.env, resolved ? [resolved] : []);
    if (exact.isErr()) {
      return jsonRepositoryError(c, exact.error.message);
    }
    const page = await searchAccountsPage(
      c.env,
      {
        localTerms: localUsername ?? query,
        remoteTerms: query.replace(/^@/, ""),
        scope: { kind: "Everyone" },
      },
      urlLookup ? 0 : limit - exact.value.length - exactLocal.value.length,
      offset,
    );
    if (page.isErr()) {
      return jsonRepositoryError(c, page.error.message);
    }
    const local = [...exactLocal.value, ...page.value.local];
    const rendered = await mastodonAccountDocuments(c.env, identity.value, local);
    const seen = new Set<string>();
    for (const document of [
      ...documentsInOrder(
        exactLocal.value.map((account) => account.id),
        rendered,
      ),
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
          if (urlLookup) {
            const found = named?.kind === "Status" ? named.status : undefined;
            if (!found) {
              return ok([]);
            }
            if (found.kind === "RemoteStatus") {
              return mastodonRemoteStatuses(c.env, identity.value, [found.status], viewerId);
            }
            statusesById.set(found.status.id, found.status);
            return mastodonStatuses(c.env, identity.value, [found.status], viewerId);
          }
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
  if (type !== "accounts" && type !== "statuses" && !urlLookup) {
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
