import { escapeHtml } from "./html";
import { ACCESS_LOGOUT_PATH } from "./access-jwt";

/**
 * The few HTML pages sign-in needs: the Access explanation, and the OAuth
 * consent screen. Plain HTML; there is no passkey ceremony.
 */

export const page = (title: string, body: string, script = ""): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
      label, input, select, button { display: block; width: 100%; box-sizing: border-box; }
      input, select, button { font: inherit; padding: 0.5rem; margin-top: 0.25rem; }
      select + label { margin-top: 0.75rem; }
      .check { display: flex; gap: 0.5rem; align-items: baseline; margin: 0.75rem 0 0; }
      .check input { width: auto; flex: none; margin: 0; }
      button { margin-top: 1rem; cursor: pointer; }
      .error { color: #b00020; }
      .muted { color: #666; }
      code { word-break: break-all; }
    </style>
  </head>
  <body>
    <main>
${body}
    </main>${script.length > 0 ? `\n    <script>\n${script}\n    </script>` : ""}
  </body>
</html>`;

/** A same-site path to continue to after sign-in; anything else goes home. */
export const safeReturnTo = (raw: string | undefined): string =>
  raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\") ? raw : "/";

const accessExplainer = (instanceName: string): string =>
  `<p>Sign-in is <strong>Cloudflare Access</strong>. Access checks a passkey of its own, or your identity provider (such as WorkOS), and sends this server a signed token. This server does not register passkeys and has no password.</p>
      <p class="muted">Open ${escapeHtml(instanceName)} through Access. A new address gets an account when registrations are open; the username comes from the address.</p>`;

/** Signed out: tell the browser that Access is the login. */
export const signInPage = (
  instanceName: string,
  returnTo: string,
  signedInAs: string | undefined,
): string =>
  page(
    `Sign in · ${instanceName}`,
    signedInAs === undefined
      ? `      <h1>Sign in to ${escapeHtml(instanceName)}</h1>
      ${accessExplainer(instanceName)}
      <p><a href="${escapeHtml(returnTo)}">Continue</a></p>`
      : `      <h1>Signed in</h1>
      <p>You are signed in to ${escapeHtml(instanceName)} as <strong>@${escapeHtml(signedInAs)}</strong> through Cloudflare Access.
      Use the web app, or an app that works with Mastodon-compatible servers, to read and post.</p>
      <form id="sign-out"><button type="submit">Sign out</button></form>
      <p id="error" class="error" role="alert"></p>`,
    signedInAs === undefined
      ? ""
      : `
      document.getElementById("sign-out").addEventListener("submit", async (event) => {
        event.preventDefault();
        const response = await fetch("/auth/sign_out", { method: "DELETE", headers: { Accept: "application/json" } });
        if (!response.ok) {
          document.getElementById("error").textContent = response.statusText;
          return;
        }
        const body = await response.json();
        location.assign(typeof body.redirect_to === "string" ? body.redirect_to : "${ACCESS_LOGOUT_PATH}");
      });`,
  );

export type ConsentRequest = Readonly<{
  clientId: string;
  redirectUri: string;
  scopes: ReadonlyArray<string>;
  state: string | undefined;
  codeChallenge: string | undefined;
  codeChallengeMethod: string | undefined;
}>;

const hidden = (name: string, value: string | undefined): string =>
  value === undefined
    ? ""
    : `\n        <input type="hidden" name="${name}" value="${escapeHtml(value)}" />`;

export const consentPage = (
  instanceName: string,
  appName: string,
  username: string,
  request: ConsentRequest,
): string =>
  page(
    `Authorize ${appName} · ${instanceName}`,
    `      <h1>Authorize ${escapeHtml(appName)}?</h1>
      <p><strong>${escapeHtml(appName)}</strong> wants to use your account
      <strong>@${escapeHtml(username)}</strong> with these permissions:</p>
      <ul>${request.scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("")}</ul>
      <form method="post" action="/oauth/authorize">${hidden("client_id", request.clientId)}${hidden("redirect_uri", request.redirectUri)}${hidden("scope", request.scopes.join(" "))}${hidden("state", request.state)}${hidden("code_challenge", request.codeChallenge)}${hidden("code_challenge_method", request.codeChallengeMethod)}
        <button type="submit" name="decision" value="approve">Authorize</button>
        <button type="submit" name="decision" value="deny">Deny</button>
      </form>`,
  );

/** `urn:ietf:wg:oauth:2.0:oob`: the user copies the code into the app. */
export const authorizationCodePage = (instanceName: string, code: string): string =>
  page(
    `Authorization code · ${instanceName}`,
    `      <h1>Authorization code</h1>
      <p>Copy this code and paste it into the application:</p>
      <p><code>${escapeHtml(code)}</code></p>`,
  );

export const errorPage = (instanceName: string, message: string): string =>
  page(
    instanceName,
    `      <h1>Something went wrong</h1>
      <p class="error">${escapeHtml(message)}</p>`,
  );
