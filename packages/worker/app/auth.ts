import { passkey } from "@better-auth/passkey";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { defineAuth } from "void/auth";
import { z } from "zod";

// Void also loads this file at build time (in Node) to emit the Better Auth
// schema, so the Worker code it calls is imported lazily, per request.
const signup = () => import("#src/passkey-signup");

const workerEnv = async (env: unknown): Promise<Env> => {
  const { isWorkerEnv } = await signup();
  if (!isWorkerEnv(env)) {
    throw new APIError("INTERNAL_SERVER_ERROR", { message: "auth: missing Worker bindings" });
  }
  return env;
};

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
 * The Better Auth endpoints tstodon calls: Void's session lookup, the sign-in
 * and sign-up pages' passkey ceremonies, and the sign-out button.
 */
const OPEN_ENDPOINTS: ReadonlySet<string> = new Set([
  "/get-session",
  "/sign-out",
  "/passkey/generate-authenticate-options",
  "/passkey/verify-authentication",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
]);

const PasskeyNameBodySchema = z.object({ name: z.string().optional() });

/**
 * Every other Better Auth endpoint is closed. Most only check that a session
 * exists, and the admin ones only that its user is an admin, so a stale or
 * stolen cookie could rename the user, list every session token, or end,
 * ban, impersonate, or create users. The Password and security page
 * (`/auth/edit`) and the admin pages do those jobs instead, and ask for a
 * recent sign-in where it matters. The guard is a `before` hook: an `after`
 * hook runs once the endpoint has already made its change. A signed-in user
 * adding a passkey needs the same recent sign-in as the page.
 */
const securityPageGuards = {
  id: "tstodon-security-page-guards",
  hooks: {
    before: [
      {
        matcher: (ctx) => !OPEN_ENDPOINTS.has(ctx.path ?? ""),
        handler: createAuthMiddleware(async () => {
          throw new APIError("FORBIDDEN", {
            message: "Manage your account on the Password and security page (/auth/edit).",
          });
        }),
      },
      {
        matcher: (ctx) =>
          ctx.path === "/passkey/generate-register-options" ||
          ctx.path === "/passkey/verify-registration",
        handler: createAuthMiddleware(async (ctx) => {
          // The passkey plugin stores any name it is sent; keep the cap the
          // rename form enforces.
          const named = PasskeyNameBodySchema.safeParse(ctx.body);
          if (
            named.success &&
            named.data.name !== undefined &&
            named.data.name.trim().length > 60
          ) {
            throw new APIError("BAD_REQUEST", {
              message: "A passkey name is at most 60 characters.",
            });
          }
          const session = await getSessionFromCtx(ctx);
          if (session && typeof ctx.query?.context === "string" && ctx.query.context !== "") {
            throw new APIError("FORBIDDEN", {
              message: "Sign out before you create another account.",
            });
          }
          const { signInIsStale } = await import("#src/recent-sign-in");
          if (session && signInIsStale(session.session.createdAt)) {
            throw new APIError("FORBIDDEN", {
              message: "Confirm with your passkey before you add another.",
            });
          }
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

/**
 * Sign-in is passkey-only: no passwords, no social providers. Mastodon
 * clients never see these sessions; `/oauth/authorize` turns one into an
 * OAuth access token.
 */
export default defineAuth(({ defaults, env }) => ({
  ...defaults,
  appName: typeof env.INSTANCE_NAME === "string" ? env.INSTANCE_NAME : "tstodon",
  emailAndPassword: { enabled: false },
  plugins: [
    sessionLookupKeepsCaching,
    securityPageGuards,
    // `user.role = 'admin'` makes the linked local account an instance admin.
    admin(),
    passkey({
      registration: {
        requireSession: false,
        // The passkey `context` is the token from the emailed sign-up link,
        // so a passkey can only be created for a confirmed address.
        resolveUser: async ({ context }) => {
          const { checkSignupLink, signupCeremonyUserId, signupErrorMessage } = await signup();
          const intent = await checkSignupLink(await workerEnv(env), context);
          if (intent.isErr()) {
            throw new APIError("BAD_REQUEST", { message: signupErrorMessage(intent.error) });
          }
          return { id: signupCeremonyUserId(intent.value.username), name: intent.value.username };
        },
        afterVerification: async ({ ctx, context, user: ceremonyUser }) => {
          const {
            consumeSignupLink,
            createSignupAccount,
            isSignupCeremony,
            signupErrorMessage,
            signupRole,
          } = await signup();
          if (!isSignupCeremony(ceremonyUser.id)) {
            // A signed-in user adding a passkey: the account exists already.
            return undefined;
          }
          const worker = await workerEnv(env);
          const intent = await consumeSignupLink(worker, context);
          if (intent.isErr()) {
            throw new APIError("BAD_REQUEST", { message: signupErrorMessage(intent.error) });
          }
          const user = await ctx.context.internalAdapter.createUser(
            {
              email: intent.value.email.reveal(),
              emailVerified: true,
              name: intent.value.username,
              role: signupRole(worker, intent.value.username),
            },
            { method: "passkey" },
          );
          const account = await createSignupAccount(worker, intent.value, user.id);
          if (account.isErr()) {
            await ctx.context.internalAdapter.deleteUser(user.id);
            throw new APIError("BAD_REQUEST", { message: signupErrorMessage(account.error) });
          }
          return { userId: user.id };
        },
      },
    }),
  ],
}));
