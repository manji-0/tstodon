import type { Context } from "hono";
import { importJWK, SignJWT } from "jose";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { jsonValidationError, readBody } from "../http";
import { AccessJwksSchema, JsonWebKeySchema } from "../access-jwt-schema";
import { vapidPublicKey } from "../vapid";
import { z } from "zod";

export const AppBodySchema = z.object({
  client_name: z.string().optional(),
  website: z.string().optional(),
  redirect_uris: z.union([z.string(), z.array(z.string())]).optional(),
});

export const OAuthTokenBodySchema = z.object({
  username: z.string().min(1),
});

const parseJsonWebKey = schemaResult(JsonWebKeySchema);
const parseAccessJwks = schemaResult(AccessJwksSchema);

export const postV1Apps = async (c: Context<{ Bindings: Env }, "/api/v1/apps">) => {
  const body = await readBody(c, AppBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const name = body.value.client_name ?? "tstodon";
  const website = body.value.website ?? null;
  const redirect = Array.isArray(body.value.redirect_uris)
    ? String(body.value.redirect_uris[0] ?? "urn:ietf:wg:oauth:2.0:oob")
    : (body.value.redirect_uris ?? "urn:ietf:wg:oauth:2.0:oob");
  return c.json({
    id: "1",
    name,
    website,
    redirect_uri: redirect,
    client_id: "tstodon-local",
    client_secret: "tstodon-local",
    vapid_key: vapidPublicKey(c.env),
  });
};

export const getV1AppsVerifyCredentials = (
  c: Context<{ Bindings: Env }, "/api/v1/apps/verify_credentials">,
) =>
  c.json({
    name: "tstodon-local",
    website: null,
    vapid_key: vapidPublicKey(c.env),
  });

export const postOauthToken = async (c: Context<{ Bindings: Env }, "/oauth/token">) => {
  const body = await readBody(c, OAuthTokenBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const privateJwkRaw = `${c.env.CF_ACCESS_LOCAL_PRIVATE_JWK ?? ""}`.trim();
  const teamDomain = `${c.env.CF_ACCESS_TEAM_DOMAIN}`.replace(/\/$/, "");
  const audience = `${c.env.CF_ACCESS_AUD}`.trim();
  if (privateJwkRaw.length === 0 || teamDomain.length === 0 || audience.length === 0) {
    return c.json({ error: "unsupported_grant_type", kind: "InvalidToken" }, 400);
  }
  const username = body.value.username.trim();
  if (username.length === 0) {
    return c.json({ error: "invalid_grant", kind: "InvalidToken" }, 400);
  }
  const email = username.includes("@") ? username : `${username}@${c.env.INSTANCE_DOMAIN}`;
  try {
    const privateJwk = parseJsonWebKey(JSON.parse(privateJwkRaw));
    if (privateJwk.isErr()) {
      return c.json({ error: "server_error", kind: "VerificationUnavailable" }, 503);
    }
    // Re-parse so jose receives a JWK without exactOptionalPropertyTypes friction.
    const key = await importJWK(JSON.parse(privateJwkRaw), "RS256");
    const jwksJson = `${c.env.CF_ACCESS_JWKS_JSON ?? ""}`;
    let kid = "tstodon-local-access";
    if (jwksJson.length > 0) {
      const parsed = parseAccessJwks(JSON.parse(jwksJson));
      if (parsed.isOk()) {
        const firstKid = parsed.value.keys[0]?.kid;
        if (typeof firstKid === "string" && firstKid.length > 0) {
          kid = firstKid;
        }
      }
    }
    const accessToken = await new SignJWT({
      email,
      type: "app",
      groups: [],
      custom: { groups: [] },
    })
      .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
      .setIssuer(teamDomain)
      .setAudience(audience)
      .setSubject(email)
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(key);
    return c.json({
      access_token: accessToken,
      token_type: "Bearer",
      scope: "read write follow push",
      created_at: Math.floor(Date.now() / 1000),
    });
  } catch {
    return c.json({ error: "server_error", kind: "VerificationUnavailable" }, 503);
  }
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([AppBodySchema, OAuthTokenBodySchema]);
