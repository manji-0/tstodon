import type { AuthorizedApp, PasskeyEntry, SessionEntry } from "./account-security-store";
import { page, PASSKEY_REGISTER, PASSKEY_SIGN_IN, WEBAUTHN_HELPERS } from "./auth-pages";
import { escapeHtml } from "./html";
import { messageLine, nav, type PageMessage } from "./settings-pages";

/**
 * Mastodon's `/auth/edit` ("Password and security"), for an account that
 * signs in with passkeys only: the passkeys, the browser sessions, and the
 * apps allowed to use the account.
 */

export type SecurityView = Readonly<{
  passkeys: ReadonlyArray<PasskeyEntry>;
  sessions: ReadonlyArray<SessionEntry & Readonly<{ current: boolean }>>;
  apps: ReadonlyArray<AuthorizedApp>;
  /**
   * `Fresh`: the sign-in is recent enough to change what protects the
   * account. `Stale`: the page offers a passkey sign-in first and leaves the
   * forms that change anything out.
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

const passkeyItem = (passkey: PasskeyEntry, view: SecurityView): string => `
        <li><strong>${escapeHtml(passkey.name ?? "Passkey")}</strong>
          <span class="muted">${passkey.addedAt === undefined ? "" : `added ${day(passkey.addedAt)}, `}${passkey.deviceType === "multiDevice" ? "synced between devices" : "this device only"}</span>
          <form method="post" action="/auth/edit/passkeys/rename">
            <input type="hidden" name="id" value="${escapeHtml(passkey.id)}" />
            <label for="name-${escapeHtml(passkey.id)}">Name</label>
            <input id="name-${escapeHtml(passkey.id)}" name="name" required maxlength="60" value="${escapeHtml(passkey.name ?? "")}" />
            <button type="submit">Rename</button>
          </form>${
            view.signIn === "Stale"
              ? ""
              : view.passkeys.length === 1
                ? `
          <p class="muted">This is your only passkey. Add another before you remove it.</p>`
                : `
          ${postForm("/auth/edit/passkeys/remove", { id: passkey.id }, "Remove passkey")}`
          }
        </li>`;

const sessionItem = (session: SecurityView["sessions"][number], view: SecurityView): string => `
        <li>${session.current ? "<strong>This browser</strong>" : "A browser"}
          <span class="muted">signed in ${minute(session.signedInAt)}${session.ipAddress === undefined ? "" : ` from ${escapeHtml(session.ipAddress)}`}</span>
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
      <p><strong>@${escapeHtml(username)}</strong> signs in with passkeys. There is no password.</p>${
        view.signIn === "Stale"
          ? `
      <form id="confirm">
        <p>To change passkeys, sessions, or app access, confirm it is you.</p>
        <button type="submit">Confirm with your passkey</button>
      </form>`
          : ""
      }
${messageLine(message)}
      <h2>Passkeys</h2>
      ${list(view.passkeys, "No passkeys.", (passkey) => passkeyItem(passkey, view))}${
        view.signIn === "Stale"
          ? ""
          : `
      <form id="add-passkey">
        <label for="new-name">Name for the new passkey</label>
        <input id="new-name" name="name" required maxlength="60" placeholder="Laptop" autocomplete="off" />
        <button type="submit">Add a passkey</button>
      </form>`
      }
      <h2>Browser sessions</h2>
      ${list(view.sessions, "No sessions.", (session) => sessionItem(session, view))}
      <h2 id="authorized-applications">Authorized apps</h2>
      ${list(view.apps, "No apps can use your account.", (app) => appItem(app, view))}`,
    view.signIn === "Stale"
      ? `${WEBAUTHN_HELPERS}${PASSKEY_SIGN_IN}
      document.getElementById("confirm").addEventListener("submit", async (event) => {
        event.preventDefault();
        show("");
        if (await signInWithPasskey()) location.reload();
      });`
      : `${WEBAUTHN_HELPERS}${PASSKEY_REGISTER}
      document.getElementById("add-passkey").addEventListener("submit", async (event) => {
        event.preventDefault();
        show("");
        const name = new FormData(event.target).get("name");
        if (await registerPasskey({}, { name })) location.reload();
      });`,
  );
