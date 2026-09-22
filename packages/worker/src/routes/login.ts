import { Hono } from "hono";

export const loginRoutes = new Hono<{ Bindings: Env }>();

loginRoutes.get("/login", (c) =>
  c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>tstodon login</title>
  </head>
  <body>
    <main>
      <h1>Sign in</h1>
      <p>
        Production authentication is enforced by Cloudflare Access with WorkOS as the identity
        provider. Open a protected API route through Access to obtain a
        <code>Cf-Access-Jwt-Assertion</code> (or present that JWT as
        <code>Authorization: Bearer …</code>).
      </p>
      <p>
        Local tests mint Access-shaped JWTs with the fixture keypair under
        <code>packages/worker/test/access-jwt-fixture.ts</code>.
      </p>
    </main>
  </body>
</html>`),
);
