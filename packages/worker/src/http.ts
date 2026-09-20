import type { Context } from "hono";
import { requireAccount, type AuthError } from "./auth";
import type { LocalAccount } from "@tstodon/domain";
import type { Result } from "neverthrow";

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
  return c.json({ error: error.message, kind: error.kind }, 500);
};

export const requireUser = async (
  c: Context<{ Bindings: Env }>,
): Promise<Result<LocalAccount, AuthError>> => requireAccount(c.req.raw, c.env);

export const jsonRepositoryError = (
  c: Context<{ Bindings: Env }>,
  message: string,
) => c.json({ error: message, kind: "RepositoryError" }, 500);

export const asBoolean = (value: unknown): boolean =>
  value === true || value === "true" || value === "1" || value === 1;

export const asStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return [];
};

export const readObjectBody = async (
  c: Context<{ Bindings: Env }>,
): Promise<Record<string, unknown>> => {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const raw = await c.req.json();
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  }
  const parsed = await c.req.parseBody();
  return { ...parsed };
};
