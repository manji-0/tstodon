import type { AccountAlias } from "./account-alias-store";
import { page } from "./auth-pages";
import { escapeHtml } from "./html";

/**
 * Account settings that Mastodon keeps in Rails pages, not in its web app:
 * the "moving from" aliases (`/settings/aliases`) and the move to another
 * account (`/settings/migration`). Plain forms in the style of the sign-in
 * pages, posted back to this origin with the session cookie.
 */

const nav = `      <p class="muted"><a href="/">Back to the web app</a> · <a href="/settings/aliases">Moving from</a> · <a href="/settings/migration">Moving to</a></p>`;

const alert = (message: string | undefined, kind: "error" | "notice" = "error"): string =>
  `      <p class="${kind === "error" ? "error" : "muted"}" role="${kind === "error" ? "alert" : "status"}">${message === undefined ? "" : escapeHtml(message)}</p>`;

export const aliasesPage = (
  instanceName: string,
  username: string,
  aliases: ReadonlyArray<AccountAlias>,
  message?: Readonly<{ kind: "error" | "notice"; text: string }>,
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
${alert(message?.text, message?.kind)}
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
