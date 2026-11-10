import type { Context } from "hono";
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

/** Read a `limit` query parameter, defaulted to `fallback` and clamped to `max`. */
const queryLimitMax = (raw: string | number | undefined, fallback: number, max: number): number => {
  const parsed = typeof raw === "number" ? Math.trunc(raw) : Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, max);
};

/** Status collections: 20 by default, capped at 40. */
export const queryLimit = (raw: string | number | undefined, fallback = 20): number =>
  queryLimitMax(raw, fallback, 40);

/** Trends: tags and links default to 10 and cap at 20, as Mastodon does. */
export const queryTrendsLimit = (raw: string | undefined): number => queryLimitMax(raw, 10, 20);

/** Mastodon's `offset` for paged lists, kept to a value SQLite can bind as an integer. */
export const queryOffset = (raw: string | number | undefined): number => {
  const parsed = typeof raw === "number" ? Math.trunc(raw) : Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, Number.MAX_SAFE_INTEGER) : 0;
};

/** Account collections (followers, blocks, directory…): 40 by default, capped at 80. */
export const queryAccountsLimit = (raw: string | number | undefined, fallback = 40): number =>
  queryLimitMax(raw, fallback, 80);

/** Notifications and notification requests: 40 by default, capped at 80. */
export const queryNotificationsLimit = (raw: string | number | undefined, fallback = 40): number =>
  queryLimitMax(raw, fallback, 80);

/** Admin lists (accounts, reports, domain blocks): 100 by default, capped at 200. */
export const queryAdminLimit = (raw: string | undefined, fallback = 100): number =>
  queryLimitMax(raw, fallback, 200);

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
  options: Readonly<{ prev?: "min_id" | "since_id" }> = {},
): void =>
  setLinkHeader(c, {
    next: rowIds.length >= limit ? rowIds.at(-1) : undefined,
    prev: rowIds[0],
    prevCursor: options.prev,
  });

/**
 * Mastodon's `Link` header from page cursors: `max_id=<next>` as `rel="next"`
 * and `min_id=<prev>` (or `since_id`) as `rel="prev"`, keeping the request's
 * other query parameters.
 */
export const setLinkHeader = (
  c: Context<{ Bindings: Env }>,
  cursors: Readonly<{
    next: string | undefined;
    prev: string | undefined;
    prevCursor?: "min_id" | "since_id" | undefined;
  }>,
): void => {
  const link = (cursor: string, value: string, rel: "next" | "prev"): string => {
    const target = new URL(c.req.url);
    target.searchParams.delete("max_id");
    target.searchParams.delete("since_id");
    target.searchParams.delete("min_id");
    target.searchParams.set(cursor, value);
    return `<${target.toString()}>; rel="${rel}"`;
  };
  const links = [
    ...(cursors.next === undefined ? [] : [link("max_id", cursors.next, "next")]),
    ...(cursors.prev === undefined
      ? []
      : [link(cursors.prevCursor ?? "min_id", cursors.prev, "prev")]),
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
 * Body for endpoints that are also valid without one: an absent (or
 * unparseable) body parses as an empty object instead of failing the request.
 */
export const readOptionalBody = async <T>(
  c: Context<{ Bindings: Env }>,
  schema: z.ZodType<T>,
): Promise<Result<T, { kind: "ValidationError" }>> => {
  let raw: unknown = {};
  try {
    raw = await readUnknownBody(c);
  } catch {
    raw = {};
  }
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
