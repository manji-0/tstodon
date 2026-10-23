import { passkey } from "@better-auth/passkey";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { defineAuth } from "void/auth";

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
    // `user.role = 'admin'` makes the linked local account an instance admin.
    admin(),
    passkey({
      registration: {
        requireSession: false,
        // The passkey `context` is the token from the emailed sign-up link,
        // so a passkey can only be created for a confirmed address.
        resolveUser: async ({ context }) => {
          const { checkSignupLink, signupErrorMessage } = await signup();
          const intent = await checkSignupLink(await workerEnv(env), context);
          if (intent.isErr()) {
            throw new APIError("BAD_REQUEST", { message: signupErrorMessage(intent.error) });
          }
          return { id: `signup:${intent.value.username}`, name: intent.value.username };
        },
        afterVerification: async ({ ctx, context }) => {
          const { consumeSignupLink, createSignupAccount, signupErrorMessage, signupRole } =
            await signup();
          const worker = await workerEnv(env);
          const intent = await consumeSignupLink(worker, context);
          if (intent.isErr()) {
            throw new APIError("BAD_REQUEST", { message: signupErrorMessage(intent.error) });
          }
          const user = await ctx.context.internalAdapter.createUser(
            {
              email: intent.value.email,
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
