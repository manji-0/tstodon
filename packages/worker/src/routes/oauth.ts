import type { Context } from "hono";
import { getUser } from "void/auth";
import { z } from "zod";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { findAccountByAuthUserId } from "../account-store";
import { getAccountModeration } from "../account-moderation-store";
import { disabledAccountIds } from "../account-flag-store";
import {
  authorizationCodePage,
  consentPage,
  errorPage,
  signInPage,
  signUpPage,
  signUpPasskeyPage,
  signUpSentPage,
  safeReturnTo,
  type ConsentRequest,
} from "../auth-pages";
import { readOptionalBody } from "../http";
import { checkSignupLink, requestSignup, signupErrorMessage } from "../passkey-signup";
import {
  authenticateOauthClient,
  consumeAuthorizationCode,
  findOauthApplicationByClientId,
  issueAccessToken,
  issueAuthorizationCode,
  pkceS256,
  revokeAccessToken,
  type OauthApplication,
} from "../oauth-store";
import { DEFAULT_SCOPES, parseScopes, scopesWithin } from "../oauth-scope";
import { parseInstanceIdentity, registrationsOpen } from "../runtime-config";

export const OOB_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

const instanceName = (env: Env): string => env.INSTANCE_NAME || "tstodon";

const AuthorizeParamsSchema = z.object({
  response_type: z.string().optional(),
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  force_login: z.string().optional(),
  decision: z.string().optional(),
});

type AuthorizeParams = z.infer<typeof AuthorizeParamsSchema>;

const parseAuthorizeParams = schemaResult(AuthorizeParamsSchema);

/**
 * A checked authorization request. Problems with the client or its redirect
 * URI are shown to the user (redirecting would hand the error to whoever
 * forged the request); every later problem goes back to the client.
 */
type AuthorizeCheck =
  | Readonly<{ kind: "ShowError"; message: string }>
  | Readonly<{ kind: "RedirectError"; redirectUri: string; state?: string; error: string }>
  | Readonly<{ kind: "Valid"; application: OauthApplication; request: ConsentRequest }>;

const checkAuthorizeRequest = async (
  env: Env,
  params: AuthorizeParams,
): Promise<AuthorizeCheck> => {
  if (!params.client_id) {
    return { kind: "ShowError", message: "Unknown application (client_id)." };
  }
  const application = await findOauthApplicationByClientId(env.DB, params.client_id);
  if (application.isErr()) {
    return { kind: "ShowError", message: "The server could not look up this application." };
  }
  if (!application.value) {
    return { kind: "ShowError", message: "Unknown application (client_id)." };
  }
  const app = application.value;
  const [onlyUri] = app.redirectUris;
  const redirectUri =
    params.redirect_uri ?? (app.redirectUris.length === 1 && onlyUri ? onlyUri : undefined);
  if (redirectUri === undefined || !app.redirectUris.includes(redirectUri)) {
    return {
      kind: "ShowError",
      message: "The redirect URI is not registered for this application.",
    };
  }
  const redirectError = (error: string): AuthorizeCheck => ({
    kind: "RedirectError",
    redirectUri,
    ...(params.state === undefined ? {} : { state: params.state }),
    error,
  });
  if (params.response_type !== undefined && params.response_type !== "code") {
    return redirectError("unsupported_response_type");
  }
  const scopes = parseScopes(params.scope, DEFAULT_SCOPES);
  if (!scopes || !scopesWithin(scopes, app.scopes)) {
    return redirectError("invalid_scope");
  }
  if (params.code_challenge !== undefined && (params.code_challenge_method ?? "plain") !== "S256") {
    // Mastodon supports only S256.
    return redirectError("invalid_request");
  }
  return {
    kind: "Valid",
    application: app,
    request: {
      clientId: app.clientId,
      redirectUri,
      scopes,
      state: params.state,
      codeChallenge: params.code_challenge,
      codeChallengeMethod: params.code_challenge === undefined ? undefined : "S256",
    },
  };
};

/** `redirect_uri` with OAuth response parameters added to its query. */
const redirectWith = (
  redirectUri: string,
  values: Readonly<Record<string, string | undefined>>,
): string => {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      target.searchParams.set(key, value);
    }
  }
  return target.toString();
};

const refuse = (c: Context<{ Bindings: Env }>, message: string, status: 400 | 403 = 400) =>
  c.html(errorPage(instanceName(c.env), message), status);

const answerCheck = (
  c: Context<{ Bindings: Env }>,
  check: Exclude<AuthorizeCheck, { kind: "Valid" }>,
) => {
  if (check.kind === "ShowError") {
    return refuse(c, check.message);
  }
  if (check.redirectUri === OOB_REDIRECT_URI) {
    return refuse(c, `Authorization failed: ${check.error}`);
  }
  return c.redirect(redirectWith(check.redirectUri, { error: check.error, state: check.state }));
};

/** The signed-in user's local account, if it may use the API. */
const signedInAccount = async (env: Env) => {
  const user = getUser();
  if (!user) {
    return { kind: "SignedOut" } as const;
  }
  const account = await findAccountByAuthUserId(env.DB, user.id);
  if (account.isErr() || !account.value) {
    return { kind: "NoAccount" } as const;
  }
  const [moderation, disabled] = await Promise.all([
    getAccountModeration(env.DB, account.value.id),
    disabledAccountIds(env.DB, [account.value.id]),
  ]);
  if (
    (moderation.isOk() && moderation.value === "Suspended") ||
    (disabled.isOk() && disabled.value.has(account.value.id))
  ) {
    return { kind: "Barred" } as const;
  }
  return { kind: "Account", account: account.value } as const;
};

const signInRedirect = (c: Context<{ Bindings: Env }>) => {
  const url = new URL(c.req.url);
  url.searchParams.delete("force_login");
  return c.redirect(`/auth/sign_in?return_to=${encodeURIComponent(url.pathname + url.search)}`);
};

export const getOauthAuthorize = async (c: Context<{ Bindings: Env }, "/oauth/authorize">) => {
  const params = parseAuthorizeParams(c.req.query());
  if (params.isErr()) {
    return refuse(c, "Malformed authorization request.");
  }
  const check = await checkAuthorizeRequest(c.env, params.value);
  if (check.kind !== "Valid") {
    return answerCheck(c, check);
  }
  if (params.value.force_login === "true" || params.value.force_login === "1") {
    return signInRedirect(c);
  }
  const signedIn = await signedInAccount(c.env);
  if (signedIn.kind === "SignedOut") {
    return signInRedirect(c);
  }
  if (signedIn.kind !== "Account") {
    return refuse(c, "This sign-in has no account that can use applications.", 403);
  }
  return c.html(
    consentPage(
      instanceName(c.env),
      check.application.name,
      signedIn.account.username,
      check.request,
    ),
  );
};

/** The consent form posts back to this origin; refuse a cross-site post. */
const sameOriginPost = (c: Context<{ Bindings: Env }>): boolean => {
  const site = c.req.header("Sec-Fetch-Site");
  if (site !== undefined && site !== "same-origin") {
    return false;
  }
  const origin = c.req.header("Origin");
  return origin === undefined || origin === new URL(c.req.url).origin;
};

export const postOauthAuthorize = async (c: Context<{ Bindings: Env }, "/oauth/authorize">) => {
  if (!sameOriginPost(c)) {
    return refuse(c, "Authorization must be confirmed on this site.", 403);
  }
  const params = await readOptionalBody(c, AuthorizeParamsSchema);
  if (params.isErr()) {
    return refuse(c, "Malformed authorization request.");
  }
  const check = await checkAuthorizeRequest(c.env, params.value);
  if (check.kind !== "Valid") {
    return answerCheck(c, check);
  }
  const signedIn = await signedInAccount(c.env);
  if (signedIn.kind === "SignedOut") {
    return refuse(c, "Your session has ended. Sign in and authorize again.", 403);
  }
  if (signedIn.kind !== "Account") {
    return refuse(c, "This sign-in has no account that can use applications.", 403);
  }
  const { request } = check;
  if (params.value.decision !== "approve") {
    return answerCheck(c, {
      kind: "RedirectError",
      redirectUri: request.redirectUri,
      ...(request.state === undefined ? {} : { state: request.state }),
      error: "access_denied",
    });
  }
  const code = await issueAuthorizationCode(c.env.DB, {
    applicationId: check.application.id,
    accountId: signedIn.account.id,
    redirectUri: request.redirectUri,
    scopes: request.scopes,
    pkce:
      request.codeChallenge === undefined
        ? undefined
        : { challenge: request.codeChallenge, method: "S256" },
  });
  if (code.isErr()) {
    return refuse(c, "The server could not issue an authorization code.");
  }
  if (request.redirectUri === OOB_REDIRECT_URI) {
    return c.html(authorizationCodePage(instanceName(c.env), code.value));
  }
  return c.redirect(redirectWith(request.redirectUri, { code: code.value, state: request.state }));
};

const TokenParamsSchema = z.object({
  grant_type: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_verifier: z.string().optional(),
  scope: z.string().optional(),
  token: z.string().optional(),
});

type TokenParams = z.infer<typeof TokenParamsSchema>;

/** RFC 6749 §2.3.1: HTTP Basic credentials win over body parameters. */
const clientCredentials = (
  c: Context<{ Bindings: Env }>,
  params: TokenParams,
): Readonly<{ clientId: string; clientSecret: string }> | undefined => {
  const header = c.req.header("Authorization");
  if (header?.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(header.slice("basic ".length).trim());
      const separator = decoded.indexOf(":");
      if (separator > 0) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, separator)),
          clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
        };
      }
    } catch {
      return undefined;
    }
  }
  return params.client_id && params.client_secret
    ? { clientId: params.client_id, clientSecret: params.client_secret }
    : undefined;
};

const oauthError = (
  c: Context<{ Bindings: Env }>,
  error: string,
  description: string,
  status: 400 | 401 | 403 | 500 = 400,
) => c.json({ error, error_description: description }, status);

const authenticatedClient = async (c: Context<{ Bindings: Env }>, params: TokenParams) => {
  const credentials = clientCredentials(c, params);
  if (!credentials) {
    return undefined;
  }
  const application = await authenticateOauthClient(
    c.env.DB,
    credentials.clientId,
    credentials.clientSecret,
  );
  return application.isOk() ? application.value : undefined;
};

export const postOauthToken = async (c: Context<{ Bindings: Env }, "/oauth/token">) => {
  const params = await readOptionalBody(c, TokenParamsSchema);
  if (params.isErr()) {
    return oauthError(c, "invalid_request", "The request body is malformed.");
  }
  const grantType = params.value.grant_type;
  if (grantType !== "authorization_code" && grantType !== "client_credentials") {
    return oauthError(c, "unsupported_grant_type", "Use authorization_code or client_credentials.");
  }
  const application = await authenticatedClient(c, params.value);
  if (!application) {
    return oauthError(c, "invalid_client", "Client authentication failed.", 401);
  }
  if (grantType === "client_credentials") {
    const scopes = parseScopes(params.value.scope, DEFAULT_SCOPES);
    if (!scopes || !scopesWithin(scopes, application.scopes)) {
      return oauthError(c, "invalid_scope", "The requested scope is not allowed.");
    }
    return tokenResponse(c, application.id, undefined, scopes);
  }
  if (!params.value.code) {
    return oauthError(c, "invalid_request", "code is required.");
  }
  const grant = await consumeAuthorizationCode(c.env.DB, params.value.code);
  if (grant.isErr()) {
    return oauthError(c, "server_error", "The code could not be redeemed.", 500);
  }
  const invalidGrant = () =>
    oauthError(c, "invalid_grant", "The authorization code is invalid, expired, or already used.");
  if (
    !grant.value ||
    grant.value.applicationId !== application.id ||
    (params.value.redirect_uri ?? grant.value.redirectUri) !== grant.value.redirectUri
  ) {
    return invalidGrant();
  }
  if (grant.value.pkce) {
    const verifier = params.value.code_verifier;
    if (!verifier || (await pkceS256(verifier)) !== grant.value.pkce.challenge) {
      return invalidGrant();
    }
  }
  return tokenResponse(c, application.id, grant.value.accountId, grant.value.scopes);
};

const tokenResponse = async (
  c: Context<{ Bindings: Env }>,
  applicationId: string,
  accountId: string | undefined,
  scopes: ReadonlyArray<string>,
) => {
  const issued = await issueAccessToken(c.env.DB, { applicationId, accountId, scopes });
  if (issued.isErr()) {
    return oauthError(c, "server_error", "The token could not be issued.", 500);
  }
  c.header("Cache-Control", "no-store");
  return c.json({
    access_token: issued.value.token,
    token_type: "Bearer",
    scope: scopes.join(" "),
    created_at: Math.floor(Date.parse(issued.value.createdAt) / 1000),
  });
};

export const postOauthRevoke = async (c: Context<{ Bindings: Env }, "/oauth/revoke">) => {
  const params = await readOptionalBody(c, TokenParamsSchema);
  if (params.isErr() || !params.value.token) {
    return oauthError(c, "invalid_request", "token is required.");
  }
  const application = await authenticatedClient(c, params.value);
  if (!application) {
    return oauthError(c, "unauthorized_client", "Client authentication failed.", 403);
  }
  const revoked = await revokeAccessToken(c.env.DB, application.id, params.value.token);
  if (revoked.isErr()) {
    return oauthError(c, "server_error", "The token could not be revoked.", 500);
  }
  return c.json({});
};

/** RFC 8414 metadata, which Mastodon 4.3 serves for client discovery. */
export const getOauthAuthorizationServerMetadata = (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  const origin = identity.isOk() ? identity.value.publicOrigin : new URL(c.req.url).origin;
  return c.json({
    issuer: `${origin}/`,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    app_registration_endpoint: `${origin}/api/v1/apps`,
    scopes_supported: ["read", "write", "push", "follow", "profile", "admin:read", "admin:write"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "client_credentials"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    service_documentation: "https://docs.joinmastodon.org/",
  });
};

const ReturnToQuerySchema = z.object({ return_to: z.string().optional() });
const parseReturnTo = schemaResult(ReturnToQuerySchema);

const returnTo = (c: Context<{ Bindings: Env }>): string => {
  const query = parseReturnTo(c.req.query());
  return safeReturnTo(query.isOk() ? query.value.return_to : undefined);
};

export const getAuthSignIn = async (c: Context<{ Bindings: Env }, "/auth/sign_in">) => {
  const signedIn = await signedInAccount(c.env);
  return c.html(
    signInPage(
      instanceName(c.env),
      returnTo(c),
      signedIn.kind === "Account" ? signedIn.account.username : undefined,
    ),
  );
};

export const getAuthSignUp = (c: Context<{ Bindings: Env }, "/auth/sign_up">) =>
  c.html(signUpPage(instanceName(c.env), registrationsOpen(c.env)));

const SignUpBodySchema = z.object({
  username: z.string().trim().default(""),
  email: z.string().trim().default(""),
});

/** Step one of sign-up: mail a confirmation link for the username and address. */
export const postAuthSignUp = async (c: Context<{ Bindings: Env }, "/auth/sign_up">) => {
  const body = await readOptionalBody(c, SignUpBodySchema);
  const form = body.isOk() ? body.value : { username: "", email: "" };
  const requested = await requestSignup(c.env, form.username, form.email);
  if (requested.isErr()) {
    const status =
      requested.error.kind === "RepositoryError" || requested.error.kind === "MailError"
        ? 500
        : 422;
    return c.html(
      signUpPage(
        instanceName(c.env),
        registrationsOpen(c.env),
        form,
        signupErrorMessage(requested.error),
      ),
      status,
    );
  }
  return c.html(signUpSentPage(instanceName(c.env), requested.value.email));
};

const TokenQuerySchema = z.object({ token: z.string().optional() });
const parseTokenQuery = schemaResult(TokenQuerySchema);

/** Step two, from the emailed link: the passkey page, if the link is still good. */
export const getAuthSignUpVerify = async (
  c: Context<{ Bindings: Env }, "/auth/sign_up/verify">,
) => {
  const query = parseTokenQuery(c.req.query());
  const token = query.isOk() ? query.value.token : undefined;
  const intent = await checkSignupLink(c.env, token);
  if (intent.isErr() || token === undefined) {
    return refuse(
      c,
      signupErrorMessage(intent.isErr() ? intent.error : { kind: "InvalidSignupLink" }),
    );
  }
  return c.html(signUpPasskeyPage(instanceName(c.env), intent.value.username, token));
};

/** The old Access explainer URL now leads to sign-in. */
export const getLogin = (c: Context<{ Bindings: Env }, "/login">) => c.redirect("/auth/sign_in");

warmSchemas([
  AuthorizeParamsSchema,
  TokenParamsSchema,
  ReturnToQuerySchema,
  SignUpBodySchema,
  TokenQuerySchema,
]);
