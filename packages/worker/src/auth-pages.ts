import { escapeHtml } from "./html";

/**
 * The few HTML pages sign-in needs: passkey sign-up and sign-in, and the
 * OAuth consent screen. Plain HTML with an inline script; there is no web UI
 * beyond them.
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
      label, input, button { display: block; width: 100%; box-sizing: border-box; }
      input, button { font: inherit; padding: 0.5rem; margin-top: 0.25rem; }
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
  raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")
    ? raw
    : "/auth/sign_in";

/** base64url <-> ArrayBuffer and the WebAuthn JSON forms simplewebauthn expects. */
const WEBAUTHN_HELPERS = `
      const fromB64u = (value) => {
        const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
        const padded = base64 + "===".slice((base64.length + 3) % 4);
        return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0)).buffer;
      };
      const toB64u = (buffer) =>
        btoa(String.fromCharCode(...new Uint8Array(buffer)))
          .replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
      const credentialIds = (list) => (list || []).map((entry) => ({ ...entry, id: fromB64u(entry.id) }));
      const show = (message) => { document.getElementById("error").textContent = message; };
      const failure = async (response) => {
        try { return (await response.json()).message || response.statusText; }
        catch { return response.statusText; }
      };`;

export type SignUpForm = Readonly<{ username: string; email: string }>;

/** Step one: username and email; the server mails a confirmation link. */
export const signUpPage = (
  instanceName: string,
  open: boolean,
  form: SignUpForm = { username: "", email: "" },
  error?: string,
): string =>
  page(
    `Sign up · ${instanceName}`,
    open
      ? `      <h1>Create an account on ${escapeHtml(instanceName)}</h1>
      <p class="muted">We email you a link to confirm the address; the link lets you create the passkey you sign in with. There is no password.</p>
      <form method="post" action="/auth/sign_up">
        <label for="username">Username</label>
        <input id="username" name="username" required maxlength="30" pattern="[A-Za-z0-9_]+" autocomplete="username" value="${escapeHtml(form.username)}" />
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" required autocomplete="email" value="${escapeHtml(form.email)}" />
        <button type="submit">Send confirmation email</button>
      </form>
      <p class="error" role="alert">${error === undefined ? "" : escapeHtml(error)}</p>
      <p><a href="/auth/sign_in">Already have an account? Sign in</a></p>`
      : `      <h1>Sign-ups are closed</h1>
      <p>${escapeHtml(instanceName)} is not accepting new accounts.</p>`,
  );

export const signUpSentPage = (instanceName: string, email: string): string =>
  page(
    `Check your email · ${instanceName}`,
    `      <h1>Check your email</h1>
      <p>We sent a link to <strong>${escapeHtml(email)}</strong>. Open it within an hour to confirm the address and create your passkey.</p>
      <p class="muted">No email? Check spam, or <a href="/auth/sign_up">start again</a>.</p>`,
  );

/** Step two, from the emailed link: create the passkey. */
export const signUpPasskeyPage = (instanceName: string, username: string, token: string): string =>
  page(
    `Create your passkey · ${instanceName}`,
    `      <h1>Create your passkey</h1>
      <p>Your email address is confirmed. Create a passkey for <strong>@${escapeHtml(username)}</strong> on ${escapeHtml(instanceName)}.</p>
      <form id="form" data-token="${escapeHtml(token)}" data-username="${escapeHtml(username)}">
        <button type="submit">Create passkey</button>
      </form>
      <p id="error" class="error" role="alert"></p>`,
    `${WEBAUTHN_HELPERS}
      document.getElementById("form").addEventListener("submit", async (event) => {
        event.preventDefault();
        show("");
        const { token, username } = event.target.dataset;
        try {
          const query = new URLSearchParams({ context: token, name: username });
          const optionsResponse = await fetch("/api/auth/passkey/generate-register-options?" + query);
          if (!optionsResponse.ok) return show(await failure(optionsResponse));
          const options = await optionsResponse.json();
          const credential = await navigator.credentials.create({
            publicKey: {
              ...options,
              challenge: fromB64u(options.challenge),
              user: { ...options.user, id: fromB64u(options.user.id) },
              excludeCredentials: credentialIds(options.excludeCredentials),
            },
          });
          const response = {
            id: credential.id,
            rawId: toB64u(credential.rawId),
            type: credential.type,
            authenticatorAttachment: credential.authenticatorAttachment || undefined,
            clientExtensionResults: credential.getClientExtensionResults(),
            response: {
              clientDataJSON: toB64u(credential.response.clientDataJSON),
              attestationObject: toB64u(credential.response.attestationObject),
              transports: credential.response.getTransports ? credential.response.getTransports() : [],
            },
          };
          const verified = await fetch("/api/auth/passkey/verify-registration", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ response, createSession: true }),
          });
          if (!verified.ok) return show(await failure(verified));
          location.assign("/auth/sign_in");
        } catch (error) {
          show(error instanceof Error ? error.message : String(error));
        }
      });`,
  );

export const signInPage = (
  instanceName: string,
  returnTo: string,
  signedInAs: string | undefined,
): string =>
  page(
    `Sign in · ${instanceName}`,
    signedInAs === undefined
      ? `      <h1>Sign in to ${escapeHtml(instanceName)}</h1>
      <form id="form" data-return-to="${escapeHtml(returnTo)}">
        <button type="submit">Sign in with a passkey</button>
      </form>
      <p id="error" class="error" role="alert"></p>
      <p><a href="/auth/sign_up">Create an account</a></p>`
      : `      <h1>Signed in</h1>
      <p>You are signed in to ${escapeHtml(instanceName)} as <strong>@${escapeHtml(signedInAs)}</strong>.
      Use a Mastodon app to read and post.</p>
      <form id="sign-out"><button type="submit">Sign out</button></form>
      <p id="error" class="error" role="alert"></p>`,
    signedInAs === undefined
      ? `${WEBAUTHN_HELPERS}
      document.getElementById("form").addEventListener("submit", async (event) => {
        event.preventDefault();
        show("");
        try {
          const optionsResponse = await fetch("/api/auth/passkey/generate-authenticate-options");
          if (!optionsResponse.ok) return show(await failure(optionsResponse));
          const options = await optionsResponse.json();
          const credential = await navigator.credentials.get({
            publicKey: {
              ...options,
              challenge: fromB64u(options.challenge),
              allowCredentials: credentialIds(options.allowCredentials),
            },
          });
          const response = {
            id: credential.id,
            rawId: toB64u(credential.rawId),
            type: credential.type,
            authenticatorAttachment: credential.authenticatorAttachment || undefined,
            clientExtensionResults: credential.getClientExtensionResults(),
            response: {
              clientDataJSON: toB64u(credential.response.clientDataJSON),
              authenticatorData: toB64u(credential.response.authenticatorData),
              signature: toB64u(credential.response.signature),
              userHandle: credential.response.userHandle ? toB64u(credential.response.userHandle) : undefined,
            },
          };
          const verified = await fetch("/api/auth/passkey/verify-authentication", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ response }),
          });
          if (!verified.ok) return show(await failure(verified));
          location.assign(event.target.dataset.returnTo);
        } catch (error) {
          show(error instanceof Error ? error.message : String(error));
        }
      });`
      : `
      document.getElementById("sign-out").addEventListener("submit", async (event) => {
        event.preventDefault();
        const response = await fetch("/api/auth/sign-out", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (response.ok) location.reload();
        else document.getElementById("error").textContent = response.statusText;
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
