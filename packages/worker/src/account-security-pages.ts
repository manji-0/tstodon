import type { AuthorizedApp, SessionEntry } from "./account-security-store";
import { ACCESS_LOGOUT_PATH } from "./access-jwt";
import { page } from "./auth-pages";
import { escapeHtml } from "./html";
import { messageLine, nav, type PageMessage } from "./settings-pages";

/**
 * Mastodon's `/auth/edit` ("Password and security") for an account that signs
 * in through Cloudflare Access: the local record of that login, and the apps
 * allowed to use the account. Passkeys stay with Access.
 */

export type SecurityView = Readonly<{
  sessions: ReadonlyArray<SessionEntry & Readonly<{ current: boolean }>>;
  apps: ReadonlyArray<AuthorizedApp>;
  /**
   * `Fresh`: the Access login is recent enough to change what protects the
   * account. `Stale`: the page points at Access and leaves those forms out.
   */
  signIn: "Fresh" | "Stale";
}>;

const day = (date: Date): string => date.toISOString().slice(0, 10);
const minute = (date: Date): string => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const postForm = (action: string, fields: Readonly<Record<string, string>>, button: string) =>
  `<form method="post" action="${action}">${Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`)
    .join("")}
          <button type="submit">${button}</button>
        </form>`;

const sessionItem = (session: SecurityView["sessions"][number], view: SecurityView): string => `
        <li>${session.current ? "<strong>This browser</strong>" : "A browser"}
          <span class="muted">signed in ${minute(session.signedInAt)}${session.ipAddress === undefined ? "" : ` from ${escapeHtml(session.ipAddress.reveal())}`}</span>
          ${session.userAgent === undefined ? "" : `<br /><span class="muted"><code>${escapeHtml(session.userAgent)}</code></span>`}${
            view.signIn === "Stale"
              ? ""
              : `
          ${postForm("/auth/edit/sessions/revoke", { id: session.id }, session.current ? "Sign out" : "End session")}`
          }
        </li>`;

const appItem = (app: AuthorizedApp, view: SecurityView): string => `
        <li><strong>${escapeHtml(app.name)}</strong>${app.website === undefined ? "" : ` <span class="muted">${escapeHtml(app.website)}</span>`}
          <br /><span class="muted">authorized ${day(app.authorizedAt)}, with</span> ${app.scopes.map((scope) => `<code>${escapeHtml(scope)}</code>`).join(" ")}${
            view.signIn === "Stale"
              ? ""
              : `
          ${postForm("/auth/edit/authorized_applications/revoke", { id: app.applicationId }, "Revoke access")}`
          }
        </li>`;

const list = <T>(items: ReadonlyArray<T>, empty: string, item: (value: T) => string): string =>
  items.length === 0
    ? `<p class="muted">${empty}</p>`
    : `<ul>${items.map(item).join("")}\n      </ul>`;

export const securityPage = (
  instanceName: string,
  username: string,
  view: SecurityView,
  message?: PageMessage,
): string =>
  page(
    `Password and security · ${instanceName}`,
    `${nav}
      <h1>Password and security</h1>
      <p><strong>@${escapeHtml(username)}</strong> signs in through Cloudflare Access. Passkeys and the identity provider (such as WorkOS) stay there. There is no password on this server.</p>${
        view.signIn === "Stale"
          ? `
      <p>To change sessions or app access, sign in again through Cloudflare Access.</p>
      <p><a href="${ACCESS_LOGOUT_PATH}">Sign in again</a></p>`
          : ""
      }
${messageLine(message)}
      <h2>Browser sessions</h2>
      ${list(view.sessions, "No sessions.", (session) => sessionItem(session, view))}
      <h2 id="authorized-applications">Authorized apps</h2>
      ${list(view.apps, "No apps can use your account.", (app) => appItem(app, view))}`,
  );
