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

export const queryLimit = (raw: string | undefined, fallback = 20): number => {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, 40);
};

export const jsonAuthError = (
  c: Context<{ Bindings: Env }>,
  error: AuthError,
) => {
  if (error.kind === "MissingToken" || error.kind === "InvalidToken") {
    return c.json(
      { error: "This method requires an authenticated user", kind: error.kind },
      401,
    );
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
): Promise<Result<AuthenticatedSession, AuthError>> =>
  requireAuthSession(c.req.raw, c.env);

export const requireAdmin = async (
  c: Context<{ Bindings: Env }>,
): Promise<Result<AuthenticatedSession, AuthError>> =>
  requireAdminSession(c.req.raw, c.env);

export const jsonRepositoryError = (
  c: Context<{ Bindings: Env }>,
  message: string,
) => c.json({ error: message, kind: "RepositoryError" }, 500);

export const jsonValidationError = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "ValidationError", kind: "ValidationError" }, 400);

export const readUnknownBody = async (
  c: Context<{ Bindings: Env }>,
): Promise<unknown> => {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return c.req.json();
  }
  return { ...(await c.req.parseBody()) };
};

export const readBody = async <T>(
  c: Context<{ Bindings: Env }>,
  schema: z.ZodType<T>,
): Promise<Result<T, { kind: "ValidationError" }>> => {
  const raw = await readUnknownBody(c);
  return schemaResult(schema)(raw).mapErr(() => ({ kind: "ValidationError" as const }));
};
