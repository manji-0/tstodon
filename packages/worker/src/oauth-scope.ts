/**
 * Mastodon OAuth scopes. Each API endpoint needs the granular scope Mastodon
 * gives it (`read:statuses`, `write:favourites`, `admin:read:accounts`, ...);
 * the top-level scope (`read`, `write`, `admin:read`, `admin:write`) covers
 * every granular scope under it, and the legacy `follow` covers the
 * relationship scopes.
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

/** What one route needs: `read` for GET/HEAD, `write` for the other methods. */
type ScopeRule = Readonly<{
  pattern: RegExp;
  read: string | undefined;
  write: string | undefined;
}>;

const NONE = undefined;

/** `/api/v1/accounts/:id/follow` → a regex matching one segment per `:param`. */
const rule = (path: string, read: string | undefined, write: string | undefined): ScopeRule => ({
  pattern: new RegExp(`^${path.replace(/\/:[a-z_]+/gi, "/[^/]+")}$`),
  read,
  write,
});

const adminRules = (resource: string, granular: boolean): ReadonlyArray<ScopeRule> => [
  rule(
    `/api/v1/admin/${resource}(?:/.*)?`,
    granular ? `admin:read:${resource}` : "admin:read",
    granular ? `admin:write:${resource}` : "admin:write",
  ),
];

/**
 * Mastodon's per-endpoint scopes (its controllers' `doorkeeper_authorize!`).
 * First match wins, so specific paths come before their parents. A route with
 * `NONE` takes any token, or none.
 */
const SCOPE_RULES: ReadonlyArray<ScopeRule> = [
  rule("/api/v1/apps/verify_credentials", NONE, NONE),
  rule("/api/v1/apps", NONE, NONE),
  rule("/api/v(?:1|2)/instance(?:/.*)?", NONE, NONE),
  rule("/api/v1/custom_emojis", NONE, NONE),
  rule("/api/v1/trends(?:/.*)?", NONE, NONE),

  rule("/api/v1/accounts/verify_credentials", "read:accounts", NONE),
  rule("/api/v1/accounts/update_credentials", NONE, "write:accounts"),
  rule("/api/v1/accounts/relationships", "read:follows", NONE),
  rule("/api/v1/accounts/familiar_followers", "read:follows", NONE),
  rule("/api/v1/accounts/(?:search|lookup)", "read:accounts", NONE),
  rule("/api/v1/accounts/:id/(?:follow|unfollow|remove_from_followers)", NONE, "write:follows"),
  rule("/api/v1/accounts/:id/(?:block|unblock)", NONE, "write:blocks"),
  rule("/api/v1/accounts/:id/(?:mute|unmute)", NONE, "write:mutes"),
  rule("/api/v1/accounts/:id/(?:endorse|unendorse|note)", NONE, "write:accounts"),
  rule("/api/v1/accounts/:id/statuses", "read:statuses", NONE),
  rule("/api/v1/accounts/:id/lists", "read:lists", NONE),
  rule("/api/v1/accounts(?:/.*)?", "read:accounts", NONE),

  ...adminRules("accounts", true),
  ...adminRules("reports", true),
  ...adminRules("domain_blocks", true),
  ...adminRules("domain_allows", true),
  ...adminRules("email_domain_blocks", true),
  ...adminRules("canonical_email_blocks", true),
  ...adminRules("announcements", false),
  ...adminRules("custom_emojis", false),
  ...adminRules("trends", false),

  rule("/api/v1/announcements/:id/reactions/:name", NONE, "write:favourites"),
  rule("/api/v1/announcements(?:/.*)?", "read", "write:accounts"),
  rule("/api/v1/blocks", "read:blocks", NONE),
  rule("/api/v1/bookmarks", "read:bookmarks", NONE),
  rule("/api/v1/conversations(?:/.*)?", "read:statuses", "write:conversations"),
  rule("/api/v1/directory", "read:accounts", NONE),
  rule("/api/v1/domain_blocks", "read:blocks", "write:blocks"),
  rule("/api/v1/endorsements", "read:accounts", NONE),
  rule("/api/v1/favourites", "read:favourites", NONE),
  rule("/api/v1/featured_tags(?:/.*)?", "read:accounts", "write:accounts"),
  rule("/api/v(?:1|2)/filters(?:/.*)?", "read:filters", "write:filters"),
  rule("/api/v1/follow_requests(?:/.*)?", "read:follows", "write:follows"),
  rule("/api/v1/followed_tags", "read:follows", NONE),
  rule("/api/v1/lists(?:/.*)?", "read:lists", "write:lists"),
  rule("/api/v1/markers", "read:statuses", "write:statuses"),
  rule("/api/v(?:1|2)/media(?:/.*)?", "write:media", "write:media"),
  rule("/api/v1/mutes", "read:mutes", NONE),
  rule("/api/v(?:1|2)/notifications(?:/.*)?", "read:notifications", "write:notifications"),
  rule("/api/v1/polls/:id/votes", NONE, "write:statuses"),
  rule("/api/v1/polls/:id", "read:statuses", NONE),
  rule("/api/v1/preferences", "read:accounts", NONE),
  rule("/api/v1/profile/(?:avatar|header)", NONE, "write:accounts"),
  rule("/api/v1/push/subscription", "push", "push"),
  rule("/api/v1/reports", NONE, "write:reports"),
  rule("/api/v1/scheduled_statuses(?:/.*)?", "read:statuses", "write:statuses"),
  rule("/api/v(?:1|2)/search", "read:search", NONE),

  rule("/api/v1/statuses/:id/(?:favourite|unfavourite)", NONE, "write:favourites"),
  rule("/api/v1/statuses/:id/(?:bookmark|unbookmark)", NONE, "write:bookmarks"),
  rule("/api/v1/statuses/:id/(?:mute|unmute)", NONE, "write:mutes"),
  rule("/api/v1/statuses/:id/(?:pin|unpin)", NONE, "write:accounts"),
  rule("/api/v1/statuses/:id/(?:favourited_by|reblogged_by)", "read:accounts", NONE),
  // Translating reads a status, though it is a POST.
  rule("/api/v1/statuses/:id/translate", NONE, "read:statuses"),
  rule("/api/v1/statuses(?:/.*)?", "read:statuses", "write:statuses"),

  rule("/api/v1/streaming(?:/.*)?", "read:statuses", NONE),
  // Mastodon's suggestions take only the top-level scopes.
  rule("/api/v(?:1|2)/suggestions(?:/.*)?", "read", "write"),
  rule("/api/v1/tags/:id/(?:follow|unfollow)", NONE, "write:follows"),
  rule("/api/v1/tags/:id/(?:feature|unfeature)", NONE, "write:accounts"),
  rule("/api/v1/tags/:name", "read:follows", NONE),
  rule("/api/v1/timelines/list/:id", "read:lists", NONE),
  rule("/api/v1/timelines(?:/.*)?", "read:statuses", NONE),
];

export type ScopeRequirement =
  | Readonly<{ kind: "None" }>
  | Readonly<{ kind: "Scope"; scope: string }>
  /** A path the table does not know: any scope of the method's family. */
  | Readonly<{ kind: "Family"; family: "read" | "write" }>;

/** The scope a request needs, from its method and path. */
export const requiredScope = (method: string, path: string): ScopeRequirement => {
  const reading = method === "GET" || method === "HEAD";
  const matched = SCOPE_RULES.find((entry) => entry.pattern.test(path));
  if (!matched) {
    return { kind: "Family", family: reading ? "read" : "write" };
  }
  const scope = reading ? matched.read : matched.write;
  return scope === undefined ? { kind: "None" } : { kind: "Scope", scope };
};

/** Mastodon's legacy `follow` scope stands for these. */
const FOLLOW_SCOPES: ReadonlySet<string> = new Set([
  "read:follows",
  "write:follows",
  "read:blocks",
  "write:blocks",
  "read:mutes",
  "write:mutes",
]);

/** Whether `granted` includes `scope` itself or a broader scope above it. */
const covers = (granted: ReadonlyArray<string>, scope: string): boolean =>
  granted.some(
    (have) =>
      have === scope ||
      scope.startsWith(`${have}:`) ||
      (have === "follow" && FOLLOW_SCOPES.has(scope)),
  );

/** Whether a token with `granted` may make a request that needs `required`. */
export const scopeAllows = (
  granted: ReadonlyArray<string>,
  required: ScopeRequirement,
  path: string,
): boolean => {
  switch (required.kind) {
    case "None":
      return true;
    case "Family":
      return granted.some(
        (have) => have === required.family || have.startsWith(`${required.family}:`),
      );
    case "Scope":
      // `profile` reads only the token owner's own account.
      return (
        covers(granted, required.scope) ||
        (path === "/api/v1/accounts/verify_credentials" && granted.includes("profile"))
      );
  }
};
