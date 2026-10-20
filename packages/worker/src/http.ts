import type { Context } from "hono";
import { schemaResult } from "@tstodon/core";
import {
  requireAccount,
  requireAdmin as requireAdminSession,
  requireSession as requireAuthSession,
  type AuthError,
  type AuthenticatedSession,
} from "./auth";
import type { LocalAccount } from "@tstodon/domain";
import type { Result } from "neverthrow";
import type { z } from "zod";

/** Read a `limit` query parameter, defaulted to `fallback` and clamped to `max`. */
const queryLimitMax = (raw: string | undefined, fallback: number, max: number): number => {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, max);
};

/** Status collections: 20 by default, capped at 40. */
export const queryLimit = (raw: string | undefined, fallback = 20): number =>
  queryLimitMax(raw, fallback, 40);

/** Account collections (followers, blocks, directory…): 40 by default, capped at 80. */
export const queryAccountsLimit = (raw: string | undefined, fallback = 40): number =>
  queryLimitMax(raw, fallback, 80);

/** Notifications and notification requests: 40 by default, capped at 80. */
export const queryNotificationsLimit = (raw: string | undefined, fallback = 40): number =>
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
): void => {
  if (rowIds.length === 0) {
    return;
  }
  const url = new URL(c.req.url);
  const link = (cursor: string, value: string, rel: "next" | "prev"): string => {
    const target = new URL(url.toString());
    target.searchParams.delete("max_id");
    target.searchParams.delete("since_id");
    target.searchParams.delete("min_id");
    target.searchParams.set(cursor, value);
    return `<${target.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (rowIds.length >= limit) {
    const last = rowIds[rowIds.length - 1];
    if (last !== undefined) {
      links.push(link("max_id", last, "next"));
    }
  }
  const first = rowIds[0];
  if (first !== undefined) {
    links.push(link("min_id", first, "prev"));
  }
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
  if (error.kind === "VerificationUnavailable") {
    c.header("Retry-After", "5");
    return c.json({ error: "verification_unavailable", kind: error.kind }, 503);
  }
  return c.json({ error: error.message, kind: error.kind }, 500);
};

export const requireUser = async (
  c: Context<{ Bindings: Env }>,
): Promise<Result<LocalAccount, AuthError>> => requireAccount(c.req.raw, c.env);

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

export const readBody = async <T>(
  c: Context<{ Bindings: Env }>,
  schema: z.ZodType<T>,
): Promise<Result<T, { kind: "ValidationError" }>> => {
  const raw = await readUnknownBody(c);
  return schemaResult(schema)(raw).mapErr(() => ({ kind: "ValidationError" as const }));
};
