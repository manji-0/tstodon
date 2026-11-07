import type { FediRole, LocalAccount } from "@tstodon/domain";
import type { Context } from "hono";
import { accessLogin } from "./access-session";

/**
 * Who a browser request acts as, from its Cloudflare Access JWT: the
 * server-rendered pages (OAuth consent, account settings, the web app) use
 * this, not a bearer token. `signedInAt` is when that Access login was
 * issued, which a page that asks for a recent sign-in compares against.
 * `sessionToken` is the secret the web app's OAuth token is derived from.
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
      /** The Better Auth user linked to the Access email, and its session row. */
      userId: string;
      sessionId: string;
      sessionToken: string;
    }>;

/** The signed-in user's local account, if Access authenticated this request. */
export const browserSession = async (request: Request, env: Env): Promise<BrowserSession> => {
  const login = await accessLogin(request, env);
  switch (login.kind) {
    case "None":
      return { kind: "SignedOut" };
    case "NoAccount":
      return { kind: "NoAccount" };
    case "Barred":
      return { kind: "Barred" };
    case "Account":
      return login;
  }
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
  return origin === undefined || origin === new URL(c.req.url).origin;
};

/** `Set-Cookie` values that expire the Better Auth session cookie, under either of its names. */
export const EXPIRED_SESSION_COOKIES: ReadonlyArray<string> = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
].map(
  (name) =>
    `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${name.startsWith("__Secure-") ? "; Secure" : ""}`,
);
