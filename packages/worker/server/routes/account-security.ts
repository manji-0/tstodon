import { warmSchemas } from "@tstodon/core";
import type { Context } from "hono";
import { z } from "zod";
import {
  listAuthorizedApplications,
  listSessions,
  revokeAuthorizedApplication,
  revokeSession,
} from "../account-security-store";
import { securityPage } from "../account-security-pages";
import { ACCESS_LOGOUT_PATH } from "../access-jwt";
import { errorPage } from "../auth-pages";
import { EXPIRED_SESSION_COOKIES, type BrowserSession } from "../browser-session";
import { readOptionalBody } from "../http";
import { pageRedirect } from "../page-redirect";
import { signInIsStale } from "../recent-sign-in";
import type { PageMessage } from "../settings-pages";
import { instanceName, settingsAccount } from "./account-settings";

/**
 * Mastodon's `/auth/edit`: the local record of the Access login, and the apps
 * allowed to use the account. Every write is a form post from this site by
 * the signed-in user, to rows that user owns, and needs a recent Access login.
 */

type Signed = Extract<BrowserSession, { kind: "Account" }>;
type SecurityContext = Context<{ Bindings: Env }>;

const render = async (
  c: SecurityContext,
  signed: Signed,
  message?: PageMessage,
  status: 200 | 403 | 404 | 422 | 500 = 200,
): Promise<Response> => {
  const [sessions, apps] = await Promise.all([
    listSessions(c.env.DB, signed.userId),
    listAuthorizedApplications(c.env.DB, signed.account.id),
  ]);
  if (sessions.isErr() || apps.isErr()) {
    return c.html(
      errorPage(instanceName(c.env), "The server could not read your security settings."),
      500,
    );
  }
  return c.html(
    securityPage(
      instanceName(c.env),
      signed.account.username,
      {
        sessions: sessions.value.map((session) => ({
          ...session,
          current: session.id === signed.sessionId,
        })),
        apps: apps.value,
        signIn: signInIsStale(signed.signedInAt) ? "Stale" : "Fresh",
      },
      message,
    ),
    status,
  );
};

const FAILED: PageMessage = {
  kind: "error",
  text: "The server could not save that. Try again.",
};

/** Mastodon's `GET /auth/edit`. */
export const getAuthEdit = async (c: Context<{ Bindings: Env }, "/auth/edit">) => {
  const signedIn = await settingsAccount(c);
  return signedIn.kind === "Answered" ? signedIn.response : render(c, signedIn);
};

/** A write that needs a recent Access login; a stale one gets the page that says so. */
const afterRecentSignIn = async (
  c: SecurityContext,
  write: (signed: Signed) => Promise<Response>,
): Promise<Response> => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  if (signInIsStale(signedIn.signedInAt)) {
    return render(
      c,
      signedIn,
      { kind: "error", text: "Sign in again through Cloudflare Access to change this." },
      403,
    );
  }
  return write(signedIn);
};

const IdFormSchema = z.object({ id: z.string().default("") });

/** End one of the signed-in user's sessions. Ending this browser's sends them to Access logout. */
export const postSessionRevoke = (c: Context<{ Bindings: Env }, "/auth/edit/sessions/revoke">) =>
  afterRecentSignIn(c, async (signed) => {
    const form = await readOptionalBody(c, IdFormSchema);
    const id = form.isOk() ? form.value.id : "";
    const revoked = await revokeSession(c.env.DB, signed.userId, id);
    if (revoked.isErr()) {
      return render(c, signed, FAILED, 500);
    }
    if (revoked.value === "NotFound") {
      return render(c, signed, { kind: "error", text: "That session was not found." }, 404);
    }
    if (id === signed.sessionId) {
      const response = pageRedirect(c, ACCESS_LOGOUT_PATH, 303);
      for (const cookie of EXPIRED_SESSION_COOKIES) {
        response.headers.append("Set-Cookie", cookie);
      }
      return response;
    }
    return render(c, signed, { kind: "notice", text: "Session ended." });
  });

/** Revoke an app's access to the signed-in user's account. */
export const postAuthorizedApplicationRevoke = (
  c: Context<{ Bindings: Env }, "/auth/edit/authorized_applications/revoke">,
) =>
  afterRecentSignIn(c, async (signed) => {
    const form = await readOptionalBody(c, IdFormSchema);
    const revoked = await revokeAuthorizedApplication(
      c.env.DB,
      signed.account.id,
      form.isOk() ? form.value.id : "",
    );
    if (revoked.isErr()) {
      return render(c, signed, FAILED, 500);
    }
    return revoked.value === "Revoked"
      ? render(c, signed, { kind: "notice", text: "Access revoked." })
      : render(c, signed, { kind: "error", text: "That app has no access to your account." }, 404);
  });

warmSchemas([IdFormSchema]);
