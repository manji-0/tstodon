import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";

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
 * Paths that get the open API CORS policy: the API, the OAuth token
 * endpoints, and the discovery documents (`/.well-known/*`, `/nodeinfo/*`).
 */
export const isApiCorsPath = (path: string): boolean =>
  under(path, "/api") ||
  under(path, "/.well-known") ||
  under(path, "/nodeinfo") ||
  path === "/oauth/token" ||
  path === "/oauth/revoke";

/**
 * Mastodon API: `Access-Control-Allow-Origin: *` like Mastodon's
 * `origins '*'`, so any browser client can call the API with a bearer token.
 * Credentials stay off: a wildcard origin cannot be combined with cookies, so
 * cookie-authenticated routes (web session, Access) are never readable
 * cross-origin through this policy.
 */
export const apiCors = (): MiddlewareHandler =>
  cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Accept", "Idempotency-Key"],
    exposeHeaders: [
      "Link",
      "X-Request-Id",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "Mastodon-Async-Refresh",
    ],
    maxAge: 86400,
    credentials: false,
  });
