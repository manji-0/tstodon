import { z } from "zod";

/** `REST::ApplicationSerializer` (`GET /api/v1/apps/verify_credentials`). */
export const ApiApplication = z.object({
  id: z.string(),
  name: z.string(),
  website: z.string().nullable(),
  scopes: z.array(z.string()),
  /** Deprecated in Mastodon 4.3: the `redirect_uris` joined by newlines. */
  redirect_uri: z.string(),
  redirect_uris: z.array(z.string()),
  /** Deprecated in Mastodon 4.3; tstodon: `null` without a VAPID key. */
  vapid_key: z.string().nullable(),
});
export type ApiApplicationJSON = z.infer<typeof ApiApplication>;

/** `REST::CredentialApplicationSerializer` (`POST /api/v1/apps`): with its client credentials. */
export const ApiCredentialApplication = ApiApplication.extend({
  client_id: z.string(),
  client_secret: z.string(),
  client_secret_expires_at: z.number(),
});
export type ApiCredentialApplicationJSON = z.infer<typeof ApiCredentialApplication>;

/**
 * `OAuthUserinfoSerializer` (`GET` or `POST /oauth/userinfo`, OpenID
 * Connect's UserInfo): `sub` is the account's ActivityPub URI, `profile` its
 * web page and `picture` its original avatar.
 */
export const ApiOAuthUserinfo = z.object({
  iss: z.string(),
  sub: z.string(),
  name: z.string(),
  preferred_username: z.string(),
  profile: z.string(),
  picture: z.string(),
});
export type ApiOAuthUserinfoJSON = z.infer<typeof ApiOAuthUserinfo>;
