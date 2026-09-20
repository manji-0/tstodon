import { schemaResult } from "@tstodon/core";
import { Hono } from "hono";
import { WorkOsAuthenticateResponseSchema } from "../schemas";

export const loginRoutes = new Hono<{ Bindings: Env }>();

const callbackPath = "/auth/workos/callback";

const clientIdOf = (env: Env): string => `${env.WORKOS_CLIENT_ID}`;

loginRoutes.get("/login", (c) => {
  const domain = `${c.env.WORKOS_AUTHKIT_DOMAIN}`;
  if (domain.length > 0) {
    const origin =
      domain.startsWith("https://") || domain.startsWith("http://")
        ? domain
        : `https://${domain}`;
    return c.redirect(`${origin.replace(/\/$/, "")}/`);
  }
  const clientId = clientIdOf(c.env);
  if (clientId.length === 0) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const redirectUri = new URL(callbackPath, c.req.url).toString();
  const authorize = new URL("https://api.workos.com/user_management/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("provider", "authkit");
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  return c.redirect(authorize.toString());
});

loginRoutes.get(callbackPath, async (c) => {
  const code = c.req.query("code") ?? "";
  const apiKey = `${c.env.WORKOS_API_KEY}`;
  const clientId = clientIdOf(c.env);
  if (code.length === 0 || apiKey.length === 0 || clientId.length === 0) {
    return c.json({ kind: "InvalidToken" }, 401);
  }
  const redirectUri = new URL(callbackPath, c.req.url).toString();
  try {
    const response = await fetch("https://api.workos.com/user_management/authenticate", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    if (response.status >= 500) {
      return c.json({ kind: "VerificationUnavailable" }, 503);
    }
    if (!response.ok) {
      return c.json({ kind: "InvalidToken" }, 401);
    }
    const parsed = schemaResult(WorkOsAuthenticateResponseSchema)(await response.json());
    if (parsed.isErr()) {
      return c.json({ kind: "InvalidToken" }, 401);
    }
    const payload = JSON.stringify({
      email: parsed.value.user.email,
      access_token: parsed.value.access_token,
    });
    return c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>tstodon WorkOS</title>
  </head>
  <body>
    <main>
      <h1>Signed in</h1>
      <p>Use this access token as <code>Authorization: Bearer …</code> on API routes.</p>
      <pre id="token"></pre>
    </main>
    <script>
      const auth = ${payload};
      document.getElementById("token").textContent = "Bearer " + auth.access_token;
    </script>
  </body>
</html>`);
  } catch {
    return c.json({ kind: "VerificationUnavailable" }, 503);
  }
});
