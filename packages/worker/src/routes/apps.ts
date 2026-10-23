import type { Context } from "hono";
import { warmSchemas } from "@tstodon/core";
import { authenticate } from "../auth";
import { jsonAuthError, readBody } from "../http";
import {
  findOauthApplicationById,
  registerOauthApplication,
  type OauthApplication,
} from "../oauth-store";
import { DEFAULT_SCOPES, parseScopes } from "../oauth-scope";
import { vapidPublicKey } from "../vapid";
import { OOB_REDIRECT_URI } from "./oauth";
import { z } from "zod";

export const AppBodySchema = z.object({
  client_name: z.string().trim().min(1).max(60),
  website: z.string().trim().optional(),
  // A string may carry several URIs, one per line; Mastodon 4.3 also takes an array.
  redirect_uris: z.union([z.string(), z.array(z.string())]),
  scopes: z.string().optional(),
});

/** `urn:ietf:wg:oauth:2.0:oob`, or an absolute URI with no fragment. */
const validRedirectUri = (uri: string): boolean => {
  if (uri === OOB_REDIRECT_URI) {
    return true;
  }
  try {
    const parsed = new URL(uri);
    return parsed.hash === "" && parsed.protocol !== "javascript:" && parsed.protocol !== "data:";
  } catch {
    return false;
  }
};

const validationFailed = (c: Context<{ Bindings: Env }>, message: string) =>
  c.json({ error: `Validation failed: ${message}` }, 422);

const appDocument = (env: Env, app: OauthApplication) => ({
  id: app.id,
  name: app.name,
  website: app.website,
  scopes: app.scopes,
  redirect_uri: app.redirectUris.join("\n"),
  redirect_uris: app.redirectUris,
  vapid_key: vapidPublicKey(env),
});

export const postV1Apps = async (c: Context<{ Bindings: Env }, "/api/v1/apps">) => {
  const body = await readBody(c, AppBodySchema);
  if (body.isErr()) {
    return validationFailed(c, "client_name and redirect_uris are required");
  }
  const redirectUris = [
    ...new Set(
      (Array.isArray(body.value.redirect_uris)
        ? body.value.redirect_uris
        : body.value.redirect_uris.split("\n")
      )
        .map((uri) => uri.trim())
        .filter((uri) => uri.length > 0),
    ),
  ];
  if (redirectUris.length === 0 || !redirectUris.every(validRedirectUri)) {
    return validationFailed(c, "Redirect URI must be an absolute URI.");
  }
  const scopes = parseScopes(body.value.scopes, DEFAULT_SCOPES);
  if (!scopes) {
    return validationFailed(c, "Scopes are not valid");
  }
  const website = body.value.website && body.value.website.length > 0 ? body.value.website : null;
  const registered = await registerOauthApplication(c.env.DB, {
    name: body.value.client_name,
    website,
    redirectUris,
    scopes,
  });
  if (registered.isErr()) {
    return c.json({ error: registered.error.message, kind: registered.error.kind }, 500);
  }
  const { application, clientSecret } = registered.value;
  return c.json({
    ...appDocument(c.env, application),
    client_id: application.clientId,
    client_secret: clientSecret,
    client_secret_expires_at: 0,
  });
};

/** The app behind the presented token, user or app-only. */
export const getV1AppsVerifyCredentials = async (
  c: Context<{ Bindings: Env }, "/api/v1/apps/verify_credentials">,
) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  if (auth.value.kind === "Anonymous") {
    return jsonAuthError(c, { kind: "MissingToken" });
  }
  const app = await findOauthApplicationById(c.env.DB, auth.value.token.applicationId);
  if (app.isErr() || !app.value) {
    return jsonAuthError(c, { kind: "InvalidToken" });
  }
  return c.json(appDocument(c.env, app.value));
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([AppBodySchema]);
