import type { LocalAccount } from "@tstodon/domain";
import type { Context } from "hono";
import { getSession } from "void/auth";
import { disabledAccountIds } from "./account-flag-store";
import { getAccountModeration } from "./account-moderation-store";
import { findAccountByAuthUserId } from "./account-store";

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
  | Readonly<{ kind: "Account"; account: LocalAccount; signedInAt: Date }>;

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
  const [moderation, disabled] = await Promise.all([
    getAccountModeration(env.DB, account.value.id),
    disabledAccountIds(env.DB, [account.value.id]),
  ]);
  if (
    (moderation.isOk() && moderation.value === "Suspended") ||
    (disabled.isOk() && disabled.value.has(account.value.id))
  ) {
    return { kind: "Barred" };
  }
  return { kind: "Account", account: account.value, signedInAt: state.session.createdAt };
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
