/**
 * Mastodon OAuth scopes. Top-level `read` / `write` / `admin:read` /
 * `admin:write` grant their whole family; a granular scope such as
 * `read:statuses` is accepted at registration and authorization and, for
 * enforcement, counts toward its family (this server does not narrow
 * endpoints per granular scope).
 */

const SCOPE_PATTERN =
  /^(?:(?:read|write)(?::[a-z_]+)?|admin:(?:read|write)(?::[a-z_]+)?|follow|push|profile)$/;

export const DEFAULT_SCOPES: ReadonlyArray<string> = ["read"];

/**
 * Space- (or `+`-) separated scopes, de-duplicated in order; `undefined`
 * when any scope is unknown. Blank input takes `fallback`.
 */
export const parseScopes = (
  raw: string | undefined,
  fallback: ReadonlyArray<string> = DEFAULT_SCOPES,
): ReadonlyArray<string> | undefined => {
  const scopes = [
    ...new Set(
      (raw ?? "")
        .split(/[\s+]+/)
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0),
    ),
  ];
  if (scopes.length === 0) {
    return fallback;
  }
  return scopes.every((scope) => SCOPE_PATTERN.test(scope)) ? scopes : undefined;
};

/** Whether `granted` covers `scope` (a top-level scope covers its granular ones). */
const grants = (granted: ReadonlyArray<string>, scope: string): boolean =>
  granted.some((have) => have === scope || scope.startsWith(`${have}:`));

/** An app may only request scopes it registered with. */
export const scopesWithin = (
  requested: ReadonlyArray<string>,
  registered: ReadonlyArray<string>,
): boolean => requested.every((scope) => grants(registered, scope));

export type RequiredScope = "read" | "write" | "push" | "admin:read" | "admin:write";

/**
 * The scope family a request needs, from its method and path; `undefined`
 * when any token will do.
 */
export const requiredScope = (method: string, path: string): RequiredScope | undefined => {
  if (path === "/api/v1/apps/verify_credentials") {
    return undefined;
  }
  const reading = method === "GET" || method === "HEAD";
  if (/^\/api\/v[12]\/admin(?:\/|$)/.test(path)) {
    return reading ? "admin:read" : "admin:write";
  }
  if (path === "/api/v1/push/subscription") {
    return "push";
  }
  return reading ? "read" : "write";
};

const family = (scope: string): string => {
  const [head, second] = scope.split(":");
  return head === "admin" ? `admin:${second ?? ""}` : (head ?? "");
};

/** Whether a token with `granted` may make a request that needs `required`. */
export const scopeAllows = (
  granted: ReadonlyArray<string>,
  required: RequiredScope | undefined,
  path: string,
): boolean => {
  if (required === undefined || granted.some((scope) => family(scope) === required)) {
    return true;
  }
  // `follow` is Mastodon's legacy alias for the relationship read/write scopes.
  if ((required === "read" || required === "write") && granted.includes("follow")) {
    return true;
  }
  // `profile` reads only the token owner's own account.
  return (
    required === "read" &&
    path === "/api/v1/accounts/verify_credentials" &&
    granted.includes("profile")
  );
};
