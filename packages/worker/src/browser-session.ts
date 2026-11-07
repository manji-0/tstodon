import type { FediRole, LocalAccount } from "@tstodon/domain";
import type { Context } from "hono";
import { getSession } from "void/auth";
import { LocalAccountModeration } from "@tstodon/domain";
import { findLocalAccountModeration } from "./account-moderation-store";
import { findAccountByAuthUserId } from "./account-store";
import { roleFromAuthUser } from "./auth";
import { parseInstanceIdentity } from "./runtime-config";

/**
 * Who a browser request acts as, from its Better Auth session cookie: the
 * server-rendered pages (OAuth consent, account settings) use this, not a
 * bearer token. `signedInAt` is when the session was created, which a page
 * that asks for a recent sign-in compares against.
 */
export type BrowserSession =
  | Readonly<{ kind: "SignedOut" }>
  | Readonly<{ kind: "NoAccount" }>
  | Readonly<{ kind: "Barred" }>
  | Readonly<{
      kind: "Account";
      account: LocalAccount;
      role: FediRole;
      signedInAt: Date;
      /** The Better Auth user and session behind the cookie. */
      userId: string;
      sessionId: string;
    }>;

/** The signed-in user's local account, if it may use the API. */
export const browserSession = async (env: Env): Promise<BrowserSession> => {
  const state = getSession();
  if (!state) {
    return { kind: "SignedOut" };
  }
  const account = await findAccountByAuthUserId(env.DB, state.user.id);
  if (account.isErr() || !account.value) {
    return { kind: "NoAccount" };
  }
  const moderation = await findLocalAccountModeration(env.DB, account.value.id);
  if (moderation.isOk() && LocalAccountModeration.isBarred(moderation.value)) {
    return { kind: "Barred" };
  }
  return {
    kind: "Account",
    account: account.value,
    role: roleFromAuthUser(Reflect.get(state.user, "role")),
    signedInAt: state.session.createdAt,
    userId: state.user.id,
    sessionId: state.session.id,
  };
};

/** `http` or `https` from the first `X-Forwarded-Proto` value a proxy sent. */
const forwardedScheme = (header: string | undefined): "http:" | "https:" | undefined => {
  const scheme = header?.split(",")[0]?.trim().toLowerCase();
  if (scheme === "http" || scheme === "https") {
    return `${scheme}:`;
  }
  return undefined;
};

/**
 * The origin of `requestUrl` after a TLS-terminating proxy. The dev server's
 * `request.url` stays `http:` on the socket to Vite; portless records the
 * browser's scheme in `X-Forwarded-Proto`.
 */
export const browserFacingOrigin = (
  requestUrl: string,
  forwardedProto: string | undefined,
): string => {
  const url = new URL(requestUrl);
  const scheme = forwardedScheme(forwardedProto);
  if (scheme !== undefined) {
    url.protocol = scheme;
  }
  return url.origin;
};

/**
 * The origin this instance tells browsers. A parsed instance identity uses its
 * public origin (`INSTANCE_PUBLIC_ORIGIN`, or `https://` plus the domain), so
 * a page served as `https://` still matches when `request.url` is `http://`.
 * When that identity does not parse, the request URL with `X-Forwarded-Proto`
 * applied is the fallback.
 */
export const pageOrigin = (env: Env, request: Request): string => {
  const identity = parseInstanceIdentity(env);
  if (identity.isOk()) {
    return new URL(identity.value.publicOrigin).origin;
  }
  return browserFacingOrigin(request.url, request.headers.get("X-Forwarded-Proto") ?? undefined);
};

/**
 * A form posts back to this origin; refuse a cross-site post. A browser's
 * Sec-Fetch-Site decides when it is sent: the pages' `no-referrer` policy
 * makes their own form posts carry `Origin: null`.
 */
export const isSameOriginPost = (c: Context<{ Bindings: Env }>): boolean => {
  const site = c.req.header("Sec-Fetch-Site");
  if (site !== undefined) {
    return site === "same-origin";
  }
  const origin = c.req.header("Origin");
  if (origin === undefined) {
    return true;
  }
  const request = c.req.raw;
  return (
    origin ===
      browserFacingOrigin(request.url, request.headers.get("X-Forwarded-Proto") ?? undefined) ||
    origin === pageOrigin(c.env, request)
  );
};

/** `Set-Cookie` values that expire the Better Auth session cookie, under either of its names. */
export const EXPIRED_SESSION_COOKIES: ReadonlyArray<string> = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
].map(
  (name) =>
    `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${name.startsWith("__Secure-") ? "; Secure" : ""}`,
);
