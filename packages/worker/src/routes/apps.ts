import { Hono } from "hono";
import { readObjectBody } from "../http";

export const appRoutes = new Hono<{ Bindings: Env }>();

appRoutes.post("/api/v1/apps", async (c) => {
  const body = await readObjectBody(c);
  const name = typeof body.client_name === "string" ? body.client_name : "tstodon";
  const website = typeof body.website === "string" ? body.website : null;
  const redirect =
    typeof body.redirect_uris === "string"
      ? body.redirect_uris
      : Array.isArray(body.redirect_uris)
        ? String(body.redirect_uris[0] ?? "urn:ietf:wg:oauth:2.0:oob")
        : "urn:ietf:wg:oauth:2.0:oob";
  return c.json({
    id: "1",
    name,
    website,
    redirect_uri: redirect,
    client_id: "tstodon-local",
    client_secret: c.env.DEV_BEARER_SECRET,
    vapid_key: null,
  });
});

appRoutes.get("/api/v1/apps/verify_credentials", (c) =>
  c.json({
    name: "tstodon-local",
    website: null,
    vapid_key: null,
  }),
);

appRoutes.post("/oauth/token", async (c) => {
  const body = await readObjectBody(c);
  const username = typeof body.username === "string" ? body.username : "";
  const secret = c.env.DEV_BEARER_SECRET;
  if (!secret || username.length === 0) {
    return c.json({ error: "invalid_grant", kind: "InvalidToken" }, 400);
  }
  return c.json({
    access_token: `${secret}:${username}`,
    token_type: "Bearer",
    scope: "read write follow push",
    created_at: Math.floor(Date.now() / 1000),
  });
});
