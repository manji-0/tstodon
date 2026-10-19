import { Hono } from "hono";
import type { Context } from "hono";
import { authenticate } from "../auth";
import { restrictedDomains } from "../admin-domain-block-store";
import { listBlockedDomains } from "../domain-block-store";
import { attachFilteredToRemoteStatuses, attachFilteredToStatuses } from "../filter-match";
import { cardDocument, parseCardJson } from "../link-card";
import { jsonAuthError, jsonRepositoryError, queryCursor, queryLimit, requireUser } from "../http";
import { mastodonRemoteStatus, mastodonStatuses, remoteStatusVisible } from "../mastodon";
import { elapsedMs, writeMetric } from "../metrics";
import { parseInstanceIdentity } from "../runtime-config";
import { findRemoteActorByUri } from "../remote-actor-store";
import { listPublicRemoteStatuses, listRemoteStatusCards } from "../remote-status-store";
import {
  listDirectStatusesForAccount,
  listHomeStatuses,
  listPublicStatuses,
  listTagStatuses,
  type TagStatusFilters,
} from "../status-store";
import { isTruthy } from "../schemas";
import { filterMutedThreads } from "../status-mute-store";

export const timelineRoutes = new Hono<{ Bindings: Env }>();

timelineRoutes.get("/api/v1/timelines/public", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const statuses = await listPublicStatuses(
    c.env.DB,
    queryLimit(c.req.query("limit")),
    queryCursor(c),
  );
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  const remote = await listPublicRemoteStatuses(c.env.DB, queryLimit(c.req.query("limit")));
  if (remote.isErr()) {
    return jsonRepositoryError(c, remote.error.message);
  }
  const localDocuments = await mastodonStatuses(c.env, identity.value, statuses.value, viewerId);
  const blockedDomains = viewerId ? await listBlockedDomains(c.env.DB, viewerId) : undefined;
  const blocked = new Set(
    (blockedDomains?.isOk() ? blockedDomains.value : []).map((domain) => domain.toLowerCase()),
  );
  for (const domain of await restrictedDomains(c.env.DB)) {
    blocked.add(domain);
  }
  const remoteCards = await listRemoteStatusCards(
    c.env.DB,
    remote.value.map((status) => status.id),
  );
  const remoteDocuments: Record<string, unknown>[] = [];
  for (const status of remote.value) {
    const actor = await findRemoteActorByUri(c.env.DB, status.actorUri);
    if (actor.isErr() || !actor.value || !remoteStatusVisible(status)) {
      continue;
    }
    if (blocked.has(actor.value.domain.toLowerCase())) {
      continue;
    }
    const rawCard = remoteCards.isOk() ? remoteCards.value.get(status.id) : undefined;
    const card = rawCard ? parseCardJson(rawCard) : undefined;
    remoteDocuments.push(
      mastodonRemoteStatus(identity.value, status, actor.value, card ? cardDocument(card) : null),
    );
  }
  const filteredLocal = await attachFilteredToStatuses(
    c.env.DB,
    viewerId,
    "public",
    statuses.value,
    localDocuments,
  );
  const filteredRemote = await attachFilteredToRemoteStatuses(
    c.env.DB,
    viewerId,
    "public",
    remote.value,
    remoteDocuments,
  );
  const merged = [...filteredLocal, ...filteredRemote].sort((left, right) => {
    const leftAt = typeof left.created_at === "string" ? left.created_at : "";
    const rightAt = typeof right.created_at === "string" ? right.created_at : "";
    return rightAt.localeCompare(leftAt);
  });
  return c.json(merged.slice(0, queryLimit(c.req.query("limit"))));
});

timelineRoutes.get("/api/v1/timelines/home", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const statuses = await listHomeStatuses(
    c.env.DB,
    user.value.id,
    queryLimit(c.req.query("limit")),
    queryCursor(c),
  );
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  const visible = await filterMutedThreads(c.env.DB, user.value.id, statuses.value);
  if (visible.isErr()) {
    return jsonRepositoryError(c, visible.error.message);
  }
  return c.json(
    await attachFilteredToStatuses(
      c.env.DB,
      user.value.id,
      "home",
      visible.value,
      await mastodonStatuses(c.env, identity.value, visible.value, user.value.id),
    ),
  );
});

/**
 * Mastodon's `any[]`/`all[]`/`none[]` on a tag timeline. Both the `name[]` and
 * `name` forms are accepted, a leading `#` is dropped, and — as the API
 * documents — at most four additional tags are applied, `any` first.
 */
const TAG_FILTER_LIMIT = 4;

const tagStatusFilters = (c: Context<{ Bindings: Env }>): TagStatusFilters => {
  const values = (key: string): string[] =>
    [...(c.req.queries(`${key}[]`) ?? []), ...(c.req.queries(key) ?? [])]
      .map((value) => value.trim().replace(/^#/, ""))
      .filter((value) => value.length > 0);
  const any: string[] = [];
  const all: string[] = [];
  const none: string[] = [];
  for (const [target, list] of [
    [any, values("any")],
    [all, values("all")],
    [none, values("none")],
  ] as const) {
    for (const value of list) {
      if (any.length + all.length + none.length >= TAG_FILTER_LIMIT) {
        break;
      }
      if (!target.includes(value)) {
        target.push(value);
      }
    }
  }
  return { any, all, none, onlyMedia: isTruthy(c.req.query("only_media")) };
};

timelineRoutes.get("/api/v1/timelines/tag/:hashtag", async (c) => {
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
  const statuses = await listTagStatuses(
    c.env.DB,
    c.req.param("hashtag"),
    queryLimit(c.req.query("limit")),
    queryCursor(c),
    tagStatusFilters(c),
  );
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  const documents = await attachFilteredToStatuses(
    c.env.DB,
    viewerId,
    "public",
    statuses.value,
    await mastodonStatuses(c.env, identity.value, statuses.value, viewerId),
  );
  writeMetric(c.env, "timeline.tag", [elapsedMs(startedAt), documents.length], ["ok"]);
  return c.json(documents);
});

timelineRoutes.get("/api/v1/timelines/direct", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const statuses = await listDirectStatusesForAccount(
    c.env.DB,
    user.value.id,
    queryLimit(c.req.query("limit")),
    c.req.query("max_id"),
  );
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  const visible = await filterMutedThreads(c.env.DB, user.value.id, statuses.value);
  if (visible.isErr()) {
    return jsonRepositoryError(c, visible.error.message);
  }
  return c.json(
    await attachFilteredToStatuses(
      c.env.DB,
      user.value.id,
      "home",
      visible.value,
      await mastodonStatuses(c.env, identity.value, visible.value, user.value.id),
    ),
  );
});
