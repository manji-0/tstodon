import type { ApiOAuthUserinfoJSON } from "@tstodon/api";
import { InstanceIdentity } from "@tstodon/domain";
import type { Context } from "hono";
import { mastodonAccountDocument } from "../account-documents";
import { pageOrigin } from "../browser-session";
import { jsonAuthError, requireUser } from "../http";
import { parseInstanceIdentity } from "../runtime-config";

/**
 * OpenID Connect's UserInfo for the token's account, as Mastodon's
 * `OAuth::UserinfoController`: a token with the `profile` scope (the scope
 * rule asks for it), answered by `GET` or `POST`. The issuer is the one the
 * authorization server metadata names.
 */
export const getOauthUserinfo = async (c: Context<{ Bindings: Env }, "/oauth/userinfo">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const account = await mastodonAccountDocument(c.env, identity.value, user.value.id, user.value);
  const userinfo: ApiOAuthUserinfoJSON = {
    iss: `${pageOrigin(c.env, c.req.raw)}/`,
    sub: InstanceIdentity.actorUrl(identity.value, user.value.username),
    name: account.display_name,
    preferred_username: user.value.username,
    profile: InstanceIdentity.profileUrl(identity.value, user.value.username),
    picture: account.avatar,
  };
  return c.json(userinfo);
};
