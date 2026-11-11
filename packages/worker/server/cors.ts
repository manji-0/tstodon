import type { Context } from "hono";
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import { optionalEnvString, parseInstanceIdentity } from "./runtime-config";

const normalizeOrigin = (value: string): string => value.trim().replace(/\/$/, "");

const splitOrigins = (raw: string): string[] =>
  raw
    .split(",")
    .map(normalizeOrigin)
    .filter((value) => value.length > 0);

/** Origins allowed to call `/api/*` and the OAuth token endpoints from a browser. */
export const apiCorsAllowedOrigins = (env: Env): ReadonlySet<string> => {
  const origins = new Set(splitOrigins(optionalEnvString(env, "CORS_ALLOWED_ORIGINS")));
  const identity = parseInstanceIdentity(env);
  if (identity.isOk()) {
    origins.add(normalizeOrigin(identity.value.publicOrigin));
  }
  return origins;
};

export const resolveApiCorsOrigin = (env: Env, requestOrigin: string): string | undefined => {
  const origin = normalizeOrigin(requestOrigin);
  if (origin.length === 0) {
    return undefined;
  }
  const allowed = apiCorsAllowedOrigins(env);
  return allowed.has(origin) ? origin : undefined;
};

/** Public media bytes — no credentials; `*` matches typical CDN/Mastodon media hosts. */
export const mediaCors = (): MiddlewareHandler =>
  cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "OPTIONS"],
    maxAge: 86400,
    exposeHeaders: ["Content-Type", "Content-Length", "ETag", "Cache-Control"],
  });

const under = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

/**
 * Paths that get the allowlisted-origin CORS policy: the API, the OAuth token
 * endpoints, and the discovery documents (`/.well-known/*`, `/nodeinfo/*`).
 */
export const isApiCorsPath = (path: string): boolean =>
  under(path, "/api") ||
  under(path, "/.well-known") ||
  under(path, "/nodeinfo") ||
  path === "/oauth/token" ||
  path === "/oauth/revoke";

/** Mastodon API — reflect allowlisted Origin so Authorization preflight works. */
export const apiCors = (): MiddlewareHandler =>
  cors({
    origin: (origin: string, c: Context<{ Bindings: Env }>) =>
      resolveApiCorsOrigin(c.env, origin) ?? undefined,
    allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    exposeHeaders: [
      "Link",
      "X-Request-Id",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
    ],
    maxAge: 86400,
    credentials: false,
  });
