import type { AccountAlias } from "./account-alias-store";
import { page, PASSKEY_SIGN_IN, WEBAUTHN_HELPERS } from "./auth-pages";
import { escapeHtml } from "./html";

/**
 * Account settings that Mastodon keeps in Rails pages, not in its web app:
 * the "moving from" aliases (`/settings/aliases`) and the move to another
 * account (`/settings/migration`). Plain forms in the style of the sign-in
 * pages, posted back to this origin with the session cookie.
 */

export type PageMessage = Readonly<{ kind: "error" | "notice"; text: string }>;

const nav = `      <p class="muted"><a href="/">Back to the web app</a> · <a href="/settings/aliases">Moving from</a> · <a href="/settings/migration">Moving to</a></p>`;

const messageLine = (message: PageMessage | undefined): string =>
  `      <p id="error" class="${message?.kind === "notice" ? "muted" : "error"}" role="alert">${message === undefined ? "" : escapeHtml(message.text)}</p>`;

export const aliasesPage = (
  instanceName: string,
  username: string,
  aliases: ReadonlyArray<AccountAlias>,
  message?: PageMessage,
): string =>
  page(
    `Moving from a different account · ${instanceName}`,
    `${nav}
      <h1>Moving from a different account</h1>
      <p>To move your followers from another account to <strong>@${escapeHtml(username)}</strong>, add the old account here first. Then start the move from the old account.</p>
      <form method="post" action="/settings/aliases">
        <label for="acct">Handle of the old account</label>
        <input id="acct" name="acct" required placeholder="username@domain" autocomplete="off" />
        <button type="submit">Create alias</button>
      </form>
${messageLine(message)}
      <h2>Aliases</h2>
      ${
        aliases.length === 0
          ? `<p class="muted">No aliases yet.</p>`
          : `<ul>${aliases
              .map(
                (alias) => `
        <li><code>${escapeHtml(alias.acct)}</code>
          <form method="post" action="/settings/aliases/remove">
            <input type="hidden" name="id" value="${escapeHtml(alias.id)}" />
            <button type="submit">Unlink alias</button>
          </form>
        </li>`,
              )
              .join("")}
      </ul>`
      }`,
  );

export type MigrationState = Readonly<{
  /** The handle of the account this one moved to, if it moved. */
  movedTo: string | undefined;
  /** When the account may move somewhere else; `undefined` when it may now. */
  nextMoveAt: Date | undefined;
  /** Whether the session is too old to move without signing in again. */
  reauthRequired: boolean;
}>;

/**
 * Mastodon's `/settings/migration`. Moving needs a recent sign-in: when the
 * session is older than that, the form signs in again with the passkey
 * before it posts.
 */
export const migrationPage = (
  instanceName: string,
  username: string,
  state: MigrationState,
  message?: PageMessage,
): string =>
  page(
    `Move to a different account · ${instanceName}`,
    `${nav}
      <h1>Move to a different account</h1>${
        state.movedTo === undefined
          ? ""
          : `
      <p><strong>@${escapeHtml(username)}</strong> has moved to <strong>${escapeHtml(state.movedTo)}</strong> and can no longer post.</p>`
      }
      <p>Moving sends your followers to the new account. First add <code>@${escapeHtml(username)}</code> as an alias on the new account, under "Moving from a different account". Your posts and the accounts you follow stay here.</p>
      ${
        state.nextMoveAt === undefined
          ? `<form id="move" method="post" action="/settings/migration">
        <label for="acct">Handle of the new account</label>
        <input id="acct" name="acct" required placeholder="username@domain" autocomplete="off" />
        <button type="submit">Move followers</button>
      </form>${state.reauthRequired ? `\n      <p class="muted">You confirm with your passkey before the move starts.</p>` : ""}`
          : `<p class="muted">You can move to a different account again after ${escapeHtml(state.nextMoveAt.toISOString())}.</p>`
      }
${messageLine(message)}`,
    state.nextMoveAt === undefined && state.reauthRequired
      ? `${WEBAUTHN_HELPERS}${PASSKEY_SIGN_IN}
      document.getElementById("move").addEventListener("submit", async (event) => {
        event.preventDefault();
        show("");
        if (await signInWithPasskey()) event.target.submit();
      });`
      : "",
  );
