import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { defineAuth } from "void/auth";

/**
 * Void's auth middleware looks up the session on every request and copies
 * that lookup's response headers onto the route's response, which would make
 * every response `Cache-Control: no-store`. The in-process lookup (no HTTP
 * request) drops them; `/api/auth/get-session` itself keeps them.
 */
const sessionLookupKeepsCaching = {
  id: "tstodon-session-lookup-headers",
  hooks: {
    after: [
      {
        matcher: (ctx) => ctx.path === "/get-session" && ctx.request === undefined,
        handler: createAuthMiddleware(async (ctx) => {
          ctx.context.responseHeaders?.delete("cache-control");
          ctx.context.responseHeaders?.delete("pragma");
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

/**
 * Better Auth stays loaded because Void mounts it and the admin role lives on
 * its user row. Nothing here signs a person in: Cloudflare Access does that.
 * These two endpoints are the ones Void and the sign-out button call.
 */
const OPEN_ENDPOINTS: ReadonlySet<string> = new Set(["/get-session", "/sign-out"]);

/**
 * Every other Better Auth endpoint is closed, including passkey registration
 * and anything the admin plugin would expose. A cookie must not be able to
 * register a credential or change users. The guard is a `before` hook: an
 * `after` hook runs once the endpoint has already made its change.
 */
const closedAuthEndpoints = {
  id: "tstodon-closed-auth-endpoints",
  hooks: {
    before: [
      {
        matcher: (ctx) => !OPEN_ENDPOINTS.has(ctx.path ?? ""),
        handler: createAuthMiddleware(async () => {
          throw new APIError("FORBIDDEN", {
            message: "Sign-in is Cloudflare Access. This server does not register passkeys.",
          });
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

/**
 * No passwords and no passkeys. Mastodon clients never see Better Auth
 * sessions; `/oauth/authorize` turns an Access login into an OAuth token.
 */
export default defineAuth(({ defaults, env }) => ({
  ...defaults,
  appName: typeof env.INSTANCE_NAME === "string" ? env.INSTANCE_NAME : "tstodon",
  emailAndPassword: { enabled: false },
  plugins: [sessionLookupKeepsCaching, closedAuthEndpoints, admin()],
}));
