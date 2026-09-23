import type { Context } from "hono";
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import { parseInstanceIdentity } from "./runtime-config";

const normalizeOrigin = (value: string): string => value.trim().replace(/\/$/, "");

const splitOrigins = (raw: string | undefined): string[] =>
  `${raw ?? ""}`
    .split(",")
    .map(normalizeOrigin)
    .filter((value) => value.length > 0);

/** Origins allowed to call `/api/*` from a browser (Bearer / Access JWT). */
export const apiCorsAllowedOrigins = (env: Env): ReadonlySet<string> => {
  const origins = new Set(
    splitOrigins((env as { CORS_ALLOWED_ORIGINS?: string }).CORS_ALLOWED_ORIGINS),
  );
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

/** Mastodon API — reflect allowlisted Origin so Authorization preflight works. */
export const apiCors = (): MiddlewareHandler =>
  cors({
    origin: (origin: string, c: Context<{ Bindings: Env }>) =>
      resolveApiCorsOrigin(c.env, origin) ?? undefined,
    allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Cf-Access-Jwt-Assertion"],
    exposeHeaders: ["Link", "X-Request-Id"],
    maxAge: 86400,
    credentials: false,
  });
