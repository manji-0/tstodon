import type { Context } from "hono";
import type { ApiStatusJSON } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import { findAccountMove } from "./account-move-store";
import {
  requireAccount,
  requireAdmin as requireAdminSession,
  requireSession as requireAuthSession,
  type AuthError,
  type AuthenticatedSession,
} from "./auth";
import type { LocalAccount } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";
import { bodyCapExceeded } from "./body-limit";

/**
 * A list's page size: what a Mastodon controller passes to
 * `Api::BaseController#limit_param(default_limit, max_limit = default_limit * 2)`.
 */
export type PageSize = Readonly<{ default: number; max: number }>;

const pageSize = (fallback: number, max = fallback * 2): PageSize => ({ default: fallback, max });

/** Mastodon v4.7.5's page sizes, named after the controller constants. */
export const PageSize = {
  /**
   * `DEFAULT_STATUSES_LIMIT`, and the same 20 as `ConversationsController::LIMIT`
   * and `Api::V2::SearchController::RESULTS_LIMIT`.
   */
  statuses: pageSize(20),
  /** `DEFAULT_ACCOUNTS_LIMIT`, and the same 40 as `DEFAULT_NOTIFICATIONS_LIMIT`. */
  accounts: pageSize(40),
  /** The trends' `DEFAULT_TAGS_LIMIT` and `DEFAULT_LINKS_LIMIT`. */
  trends: pageSize(10),
  /**
   * `DomainBlocksController::BLOCK_LIMIT`, and the same 100 as
   * `FollowedTagsController::TAGS_LIMIT`.
   */
  domainBlocks: pageSize(100),
  /**
   * `DEFAULT_NOTIFICATIONS_COUNT_LIMIT` and `MAX_NOTIFICATIONS_COUNT_LIMIT`,
   * how many unread notifications `unread_count` counts.
   */
  unreadNotifications: pageSize(100, 1000),
  /** The admin lists' `LIMIT`. */
  admin: pageSize(100),
  /** `LIMIT` and `MAX_LIMIT` of the admin domain blocks and domain allows. */
  adminDomainRules: pageSize(100, 500),
} satisfies Record<string, PageSize>;

const RUBY_INTEGER_PREFIX = /^[\t\n\v\f\r ]*([+-]?\d+(?:_\d+)*)/;

/**
 * Ruby's `String#to_i`: the integer the string starts with, after ASCII
 * whitespace and with `_` between digits; 0 when it starts with none.
 */
export const rubyToI = (raw: string): number => {
  const digits = RUBY_INTEGER_PREFIX.exec(raw)?.[1];
  return digits === undefined ? 0 : Number.parseInt(digits.replaceAll("_", ""), 10);
};

/**
 * Mastodon's `limit_param`: the default without a `limit`, else
 * `[params[:limit].to_i.abs, max].min`, so a `limit` that reads as 0 (`0`,
 * `abc`, or empty) asks for an empty page.
 */
export const limitParam = (raw: string | undefined, size: PageSize): number =>
  raw === undefined ? size.default : Math.min(Math.abs(rubyToI(raw)), size.max);

/**
 * A query parameter with a bare key read as Rack reads it: `?limit` with no
 * `=` is `nil` (`undefined`) in Mastodon's `params`, not the empty string
 * `URLSearchParams` makes of it. A repeated key takes its first pair, as
 * every other query parameter here does.
 */
export const rackQueryParam = (url: string, name: string): string | undefined => {
  for (const pair of new URL(url).search.slice(1).split("&")) {
    const [entry] = new URLSearchParams(pair);
    if (entry?.[0] === name) {
      return pair.includes("=") ? entry[1] : undefined;
    }
  }
  return undefined;
};

/** The request's `limit` query parameter as Rack reads it, then as {@link limitParam}. */
export const queryLimit = (c: Context<{ Bindings: Env }>, size: PageSize): number =>
  limitParam(rackQueryParam(c.req.url, "limit"), size);

/** Mastodon's `unlimited?` (`params[:limit] == '0'`): exactly `limit=0` asks for every row. */
export const queryUnlimited = (c: Context<{ Bindings: Env }>): boolean =>
  rackQueryParam(c.req.url, "limit") === "0";

/** Mastodon's `offset` for paged lists, kept to a value SQLite can bind as an integer. */
export const queryOffset = (raw: string | number | undefined): number => {
  const parsed = typeof raw === "number" ? Math.trunc(raw) : Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, Number.MAX_SAFE_INTEGER) : 0;
};

/**
 * The filters a `Link` keeps besides `limit` and its cursor: what the
 * controller's `pagination_params` permits beyond Mastodon's
 * `Api::Pagination::PAGINATION_PARAMS` (`limit` alone). An array filter
 * matches with or without its `[]`.
 */
export type LinkFilters = ReadonlyArray<string>;

/**
 * Mastodon's `Link` pagination headers for a collection of row ids: a full page
 * offers `max_id=<last id>` as `rel="next"`, and any page offers
 * `min_id=<first id>` as `rel="prev"`. Row ids are what clients page these
 * account collections by, even though the documents carry account ids.
 */
export const setPaginationLinks = (
  c: Context<{ Bindings: Env }>,
  rowIds: ReadonlyArray<string>,
  limit: number,
  options: Readonly<{ prev?: "min_id" | "since_id"; filters?: LinkFilters }> = {},
): void =>
  setLinkHeader(
    c,
    {
      next: rowIds.length >= limit ? rowIds.at(-1) : undefined,
      prev: rowIds[0],
      prevCursor: options.prev,
    },
    options.filters,
  );

/**
 * Mastodon's `Link` header for a list that offers the next page after any page
 * that is not empty (the timelines' `unless: -> { @statuses.empty? }`, v1
 * notifications): `max_id=<last id>` as `rel="next"` and `min_id=<first id>`
 * as `rel="prev"`. An empty page gets no `Link`.
 */
export const setTimelineLinks = (
  c: Context<{ Bindings: Env }>,
  ids: ReadonlyArray<string>,
  filters: LinkFilters = [],
): void => setLinkHeader(c, { next: ids.at(-1), prev: ids[0] }, filters);

/**
 * A timeline page as `Api::V1::Timelines::BaseController` answers it: its
 * statuses, and a `Link` with the page's cursors keeping `filters`.
 */
export const timelineResponse = (
  c: Context<{ Bindings: Env }>,
  page: Readonly<{
    statuses: ApiStatusJSON[];
    next: string | undefined;
    prev: string | undefined;
  }>,
  filters: LinkFilters = [],
) => {
  setLinkHeader(c, { next: page.next, prev: page.prev }, filters);
  return c.json(page.statuses);
};

/**
 * Mastodon's `Link` header from page cursors: `max_id=<next>` as `rel="next"`
 * and `min_id=<prev>` (or `since_id`) as `rel="prev"`, keeping the request's
 * `limit` and `filters`.
 */
export const setLinkHeader = (
  c: Context<{ Bindings: Env }>,
  cursors: Readonly<{
    next: string | undefined;
    prev: string | undefined;
    prevCursor?: "min_id" | "since_id" | undefined;
  }>,
  filters: LinkFilters = [],
): void =>
  setLinks(c, filters, {
    next: cursors.next === undefined ? undefined : ["max_id", cursors.next],
    prev: cursors.prev === undefined ? undefined : [cursors.prevCursor ?? "min_id", cursors.prev],
  });

/**
 * Mastodon's `Link` header for a list paged by `offset` (trends): a full page
 * offers `offset + limit` as `rel="next"`, and a page past the first offers
 * `offset - limit` (at least 0) as `rel="prev"`, keeping the request's `limit`.
 * A `limit` of 0 gets no links: both would point at the page itself.
 */
export const setOffsetPaginationLinks = (
  c: Context<{ Bindings: Env }>,
  page: Readonly<{ offset: number; limit: number; count: number }>,
): void => {
  if (page.limit === 0) {
    return;
  }
  setLinks(c, [], {
    next: page.count >= page.limit ? ["offset", String(page.offset + page.limit)] : undefined,
    prev: page.offset > 0 ? ["offset", String(Math.max(page.offset - page.limit, 0))] : undefined,
  });
};

/** The `Link` header: the request URL keeping `limit` and `filters`, plus each rel's cursor. */
const setLinks = (
  c: Context<{ Bindings: Env }>,
  filters: LinkFilters,
  rels: Readonly<Record<"next" | "prev", readonly [string, string] | undefined>>,
): void => {
  const kept = new Set(["limit", ...filters]);
  const request = new URL(c.req.url);
  const link = ([param, value]: readonly [string, string], rel: "next" | "prev"): string => {
    const target = new URL(request);
    target.search = "";
    for (const [name, keptValue] of request.searchParams) {
      if (kept.has(name.endsWith("[]") ? name.slice(0, -2) : name)) {
        target.searchParams.append(name, keptValue);
      }
    }
    target.searchParams.set(param, value);
    return `<${target.toString()}>; rel="${rel}"`;
  };
  const links = [
    ...(rels.next === undefined ? [] : [link(rels.next, "next")]),
    ...(rels.prev === undefined ? [] : [link(rels.prev, "prev")]),
  ];
  if (links.length > 0) {
    c.header("Link", links.join(", "));
  }
};

/** Mastodon's `max_id` / `since_id` / `min_id` query cursors. */
export const queryCursor = (
  c: Context<{ Bindings: Env }>,
): Readonly<{
  maxId?: string | undefined;
  sinceId?: string | undefined;
  minId?: string | undefined;
}> => ({
  maxId: c.req.query("max_id"),
  sinceId: c.req.query("since_id"),
  minId: c.req.query("min_id"),
});

export const jsonAuthError = (c: Context<{ Bindings: Env }>, error: AuthError) => {
  if (error.kind === "MissingToken" || error.kind === "InvalidToken") {
    return c.json({ error: "This method requires an authenticated user", kind: error.kind }, 401);
  }
  if (error.kind === "Forbidden") {
    return c.json({ error: "This action is not allowed", kind: error.kind }, 403);
  }
  if (error.kind === "InsufficientScope") {
    return c.json({ error: "This action is outside the authorized scopes", kind: error.kind }, 403);
  }
  if (error.kind === "VerificationUnavailable") {
    c.header("Retry-After", "5");
    return c.json({ error: "verification_unavailable", kind: error.kind }, 503);
  }
  return c.json({ error: error.message, kind: error.kind }, 500);
};

export const requireUser = async (
  c: Context<{ Bindings: Env }>,
): Promise<Result<LocalAccount, AuthError>> => requireAccount(c.req.raw, c.env);

/**
 * {@link requireUser} for the actions a moved account may no longer take. As
 * with Mastodon (4.4 `Api::BaseController#require_user!`, which refuses a user
 * whose `User#functional?` is false once `moved_to_account_id` is set), a
 * moved account is answered 403 "Your login is currently disabled". The error
 * is the response to return.
 */
export const requireFunctionalUser = async (
  c: Context<{ Bindings: Env }>,
): Promise<Result<LocalAccount, Response>> => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return err(jsonAuthError(c, user.error));
  }
  const move = await findAccountMove(c.env.DB, user.value.id);
  if (move.isErr()) {
    return err(jsonRepositoryError(c, move.error.message));
  }
  if (move.value) {
    return err(c.json({ error: "Your login is currently disabled", kind: "Forbidden" }, 403));
  }
  return ok(user.value);
};

export const requireSession = async (
  c: Context<{ Bindings: Env }>,
): Promise<Result<AuthenticatedSession, AuthError>> => requireAuthSession(c.req.raw, c.env);

export const requireAdmin = async (
  c: Context<{ Bindings: Env }>,
): Promise<Result<AuthenticatedSession, AuthError>> => requireAdminSession(c.req.raw, c.env);

export const jsonRepositoryError = (c: Context<{ Bindings: Env }>, message: string) =>
  c.json({ error: message, kind: "RepositoryError" }, 500);

export const jsonValidationError = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "ValidationError", kind: "ValidationError" }, 400);

export const readUnknownBody = async (c: Context<{ Bindings: Env }>): Promise<unknown> => {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return c.req.json();
  }
  return { ...(await c.req.parseBody()) };
};

/**
 * The body, or `{}` when there is none or it does not decode. An oversized
 * body is not an absent one: its error goes on, and the body cap answers 413
 * before the handler acts on an empty body.
 */
export const readUnknownBodyOrEmpty = async (c: Context<{ Bindings: Env }>): Promise<unknown> => {
  try {
    return await readUnknownBody(c);
  } catch (cause) {
    if (bodyCapExceeded(c.req.raw)) {
      throw cause;
    }
    return {};
  }
};

/**
 * Body for endpoints that are also valid without one: an absent (or
 * unparseable) body parses as an empty object instead of failing the request.
 */
export const readOptionalBody = async <T>(
  c: Context<{ Bindings: Env }>,
  schema: z.ZodType<T>,
): Promise<Result<T, { kind: "ValidationError" }>> => {
  const raw = await readUnknownBodyOrEmpty(c);
  return schemaResult(schema)(raw).mapErr(() => ({ kind: "ValidationError" as const }));
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Rails-style form keys (`subscription[keys][auth]`) folded into nested
 * objects, so one schema reads both a form body and its JSON equivalent.
 */
export const nestFormKeys = (flat: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const root: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const path = key.match(/^([^[\]]+)((?:\[[^[\]]*\])*)$/);
    if (!path?.[1]) {
      root[key] = value;
      continue;
    }
    const segments = [
      path[1],
      ...[...(path[2] ?? "").matchAll(/\[([^[\]]*)\]/g)].map((m) => m[1] ?? ""),
    ];
    let node = root;
    for (const [index, segment] of segments.entries()) {
      if (index === segments.length - 1) {
        node[segment] = value;
        break;
      }
      const next = node[segment];
      if (isPlainRecord(next)) {
        node = next;
      } else {
        const created: Record<string, unknown> = {};
        node[segment] = created;
        node = created;
      }
    }
  }
  return root;
};

/** {@link readBody} for bodies whose form encoding nests keys in brackets. */
export const readNestedBody = async <T>(
  c: Context<{ Bindings: Env }>,
  schema: z.ZodType<T>,
): Promise<Result<T, { kind: "ValidationError" }>> => {
  const contentType = c.req.header("content-type") ?? "";
  const raw: unknown = contentType.includes("application/json")
    ? await c.req.json()
    : nestFormKeys({ ...(await c.req.parseBody()) });
  return schemaResult(schema)(raw).mapErr(() => ({ kind: "ValidationError" as const }));
};

export const readBody = async <T>(
  c: Context<{ Bindings: Env }>,
  schema: z.ZodType<T>,
): Promise<Result<T, { kind: "ValidationError" }>> => {
  const raw = await readUnknownBody(c);
  return schemaResult(schema)(raw).mapErr(() => ({ kind: "ValidationError" as const }));
};
