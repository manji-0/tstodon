import { schemaResult } from "@tstodon/core";
import { z } from "zod";

/*
 * Rate limits, after Mastodon's Rack::Attack throttles and its `RateLimiter`
 * families. This module is the policy: which counters a request counts
 * against, how a fixed window advances, and what the counts mean. Where the
 * counts live is the worker's business (see `rate-limit-counter.ts`).
 *
 * Every counter is a fixed window aligned to the epoch, as Rack::Attack's
 * are: a 5-minute window starts on a multiple of 300 seconds, and its reset
 * is the next multiple.
 */

/** The throttles, by the names `RATE_LIMITS` overrides them under. */
export const RATE_LIMIT_BUCKETS = [
  /** Unauthenticated `/api/*` requests, per client address (`throttle_unauthenticated_api`). */
  "api_ip",
  /** `/api/*` requests per OAuth token (`throttle_per_token_api`). */
  "api_token",
  /** `/api/*` requests per signed-in account, over all its tokens (`throttle_authenticated_api`). */
  "api_account",
  /** Media uploads per account (`throttle_api_media`, `RateLimiter` `media`). */
  "media",
  /** Statuses posted per account (`RateLimiter` `statuses`). */
  "statuses",
  /** Boosts per account (`RateLimiter` `reblogs`). */
  "reblogs",
  /** Follows per account (`RateLimiter` `follows`). */
  "follows",
  /** Reports filed per account (`RateLimiter` `reports`). */
  "reports",
  /** Sign-in pages and OAuth consent per client address (`throttle_login_attempts/ip`). */
  "sign_in",
  /** OAuth app registrations per client address. */
  "app_registration",
  /** OAuth token requests per client address. */
  "oauth_token",
  /** WebFinger, NodeInfo and actor/object fetches per client address. */
  "federation_fetch",
  /** Inbox deliveries per client address, before the signature is checked. */
  "inbox_ip",
  /** Inbox deliveries per sending server, once its signature verified. */
  "inbox_domain",
] as const;

export type RateLimitBucket = (typeof RATE_LIMIT_BUCKETS)[number];

const ThrottleSchema = z.object({
  kind: z.literal("Throttle"),
  limit: z.int().positive(),
  /** The window, in seconds. */
  period: z.int().positive(),
});
const UnlimitedSchema = z.object({ kind: z.literal("Unlimited") });
const RateLimitRuleSchema = z.discriminatedUnion("kind", [ThrottleSchema, UnlimitedSchema]);

/** One bucket's limit, or none. */
export type RateLimitRule = z.infer<typeof RateLimitRuleSchema>;

export type RateLimitPolicy = Readonly<Record<RateLimitBucket, RateLimitRule>>;

const throttle = (limit: number, period: number): RateLimitRule => ({
  kind: "Throttle",
  limit,
  period,
});

const MINUTES = 60;
const HOURS = 60 * MINUTES;

/** Mastodon's numbers where it has one; see docs/reference/configuration.md. */
const DEFAULT_POLICY: RateLimitPolicy = {
  api_ip: throttle(300, 5 * MINUTES),
  api_token: throttle(300, 5 * MINUTES),
  api_account: throttle(1500, 5 * MINUTES),
  media: throttle(30, 30 * MINUTES),
  statuses: throttle(300, 3 * HOURS),
  reblogs: throttle(300, 3 * HOURS),
  follows: throttle(400, 24 * HOURS),
  reports: throttle(400, 24 * HOURS),
  sign_in: throttle(25, 5 * MINUTES),
  app_registration: throttle(5, 10 * MINUTES),
  oauth_token: throttle(25, 5 * MINUTES),
  federation_fetch: throttle(1500, 5 * MINUTES),
  inbox_ip: throttle(1500, 5 * MINUTES),
  inbox_domain: throttle(3000, 5 * MINUTES),
};

/**
 * An override as an operator writes it in `RATE_LIMITS`: `{ "limit": n,
 * "period": seconds }`, or `false` to lift the bucket's limit.
 */
const OverrideSchema = z.union([
  z.literal(false),
  z.object({ limit: z.int().positive(), period: z.int().positive() }).strict(),
]);

/** Unknown bucket names fail the whole value, so a typo is not silently a default. */
const OverridesSchema = z.record(z.literal(RATE_LIMIT_BUCKETS), OverrideSchema.optional());

const parseOverrides = schemaResult(OverridesSchema);

const isBucket = (name: string): name is RateLimitBucket =>
  RATE_LIMIT_BUCKETS.some((bucket) => bucket === name);

export const RateLimitPolicy = {
  defaults: DEFAULT_POLICY,
  /**
   * The defaults with `overrides` (the parsed `RATE_LIMITS` JSON) applied.
   * A value that is not an object of known buckets is an error.
   */
  withOverrides: (overrides: unknown) =>
    parseOverrides(overrides).map((parsed): RateLimitPolicy => {
      const policy: Record<RateLimitBucket, RateLimitRule> = { ...DEFAULT_POLICY };
      for (const [name, override] of Object.entries(parsed)) {
        if (!isBucket(name) || override === undefined) {
          continue;
        }
        policy[name] =
          override === false ? { kind: "Unlimited" } : throttle(override.limit, override.period);
      }
      return policy;
    }),
} as const;

const IpSubjectSchema = z.object({ kind: z.literal("Ip"), key: z.string().min(1) });
const AccountSubjectSchema = z.object({ kind: z.literal("Account"), accountId: z.string().min(1) });
const TokenSubjectSchema = z.object({ kind: z.literal("Token"), tokenId: z.string().min(1) });
const RemoteDomainSubjectSchema = z.object({
  kind: z.literal("RemoteDomain"),
  host: z.string().min(1),
});
const RateLimitSubjectSchema = z.discriminatedUnion("kind", [
  IpSubjectSchema,
  AccountSubjectSchema,
  TokenSubjectSchema,
  RemoteDomainSubjectSchema,
]);

/**
 * Whose counters a request counts against. Each subject's counters are kept
 * together, so one request costs one counter call per subject.
 */
export type RateLimitSubject = z.infer<typeof RateLimitSubjectSchema>;

export const RateLimitSubject = {
  schema: RateLimitSubjectSchema,
  /** The subject's storage key: `ip:…`, `account:…`, `token:…` or `domain:…`. */
  key: (subject: RateLimitSubject): string => {
    switch (subject.kind) {
      case "Ip":
        return `ip:${subject.key}`;
      case "Account":
        return `account:${subject.accountId}`;
      case "Token":
        return `token:${subject.tokenId}`;
      case "RemoteDomain":
        return `domain:${subject.host.toLowerCase()}`;
    }
  },
} as const;

/** One counter a request increments, with the limit it is held to. */
export type RateLimitHit = Readonly<{
  /** The counter's name within its subject (the bucket, or `api_token:<id>`). */
  name: string;
  bucket: RateLimitBucket;
  limit: number;
  periodMs: number;
}>;

/**
 * A hit counted `by` times at once: the hits an isolate counted alone,
 * handed to the shared counter together.
 */
export type RateLimitIncrement = RateLimitHit & Readonly<{ by: number }>;

/** The counters a request increments under one subject. */
export type RateLimitCheck = Readonly<{
  subject: RateLimitSubject;
  hits: ReadonlyArray<RateLimitHit>;
}>;

/** A counter after a hit: its count in the current window, and when the window ends. */
export type RateLimitCounterState = Readonly<{
  name: string;
  limit: number;
  count: number;
  resetAtMs: number;
}>;

/** Who sent a request, as far as rate limits care. */
export type RateLimitCaller =
  | Readonly<{ kind: "Anonymous" }>
  /** A valid token with no account (`client_credentials`). */
  | Readonly<{ kind: "Application"; tokenId: string }>
  | Readonly<{ kind: "Account"; accountId: string; tokenId: string }>;

export type RateLimitRequest = Readonly<{
  method: string;
  path: string;
  /** The client address's throttle key (`IpRange.throttleKey`), when Cloudflare named one. */
  ip: string | undefined;
  caller: RateLimitCaller;
}>;

/**
 * Mastodon's `api_request?`: the REST API. The streaming socket (a separate
 * server in Mastodon) and Better Auth's endpoints under `/api/auth` are not
 * Mastodon's API.
 */
export const isApiPath = (path: string): boolean =>
  (path === "/api" || path.startsWith("/api/")) &&
  !path.startsWith("/api/v1/streaming") &&
  !path.startsWith("/api/auth/");

const MEDIA_UPLOAD = /^\/api\/v[12]\/media\/?$/;
const STATUS_CREATE = /^\/api\/v1\/statuses\/?$/;
const REBLOG = /^\/api\/v1\/statuses\/[^/]+\/reblog\/?$/;
const FOLLOW = /^\/api\/v1\/accounts\/[^/]+\/follow\/?$/;
const REPORT = /^\/api\/v1\/reports\/?$/;
const APP_REGISTRATION = /^\/api\/v1\/apps\/?$/;
const USER_INBOX = /^\/users\/[^/]+\/inbox\/?$/;
const FEDERATION_FETCH = /^\/(?:\.well-known\/[^/]+|nodeinfo(?:\/.*)?|users\/.+|actor)\/?$/;

const isInboxPath = (path: string): boolean =>
  path === "/inbox" || path === "/actor/inbox" || USER_INBOX.test(path);

/** The per-account action families a request counts against (Mastodon's `RateLimiter`). */
const accountFamilies = (method: string, path: string): ReadonlyArray<RateLimitBucket> => {
  if (method !== "POST") {
    return [];
  }
  if (MEDIA_UPLOAD.test(path)) {
    return ["media"];
  }
  if (STATUS_CREATE.test(path)) {
    return ["statuses"];
  }
  if (REBLOG.test(path)) {
    return ["reblogs"];
  }
  if (FOLLOW.test(path)) {
    return ["follows"];
  }
  if (REPORT.test(path)) {
    return ["reports"];
  }
  return [];
};

/** The address-keyed buckets a request counts against. */
const ipBuckets = (
  method: string,
  path: string,
  caller: RateLimitCaller,
): ReadonlyArray<RateLimitBucket> => {
  const buckets: RateLimitBucket[] = [];
  if (caller.kind === "Anonymous" && isApiPath(path)) {
    buckets.push("api_ip");
  }
  if (method === "POST") {
    if (APP_REGISTRATION.test(path)) {
      buckets.push("app_registration");
    } else if (path === "/oauth/token") {
      buckets.push("oauth_token");
    } else if (path === "/oauth/authorize") {
      buckets.push("sign_in");
    } else if (isInboxPath(path)) {
      buckets.push("inbox_ip");
    }
  }
  if (method === "GET" || method === "HEAD") {
    if (path === "/auth/sign_in") {
      buckets.push("sign_in");
    } else if (FEDERATION_FETCH.test(path)) {
      buckets.push("federation_fetch");
    }
  }
  return buckets;
};

const hitFor = (
  policy: RateLimitPolicy,
  bucket: RateLimitBucket,
  name: string = bucket,
): RateLimitHit | undefined => {
  const rule = policy[bucket];
  return rule.kind === "Throttle"
    ? { name, bucket, limit: rule.limit, periodMs: rule.period * 1000 }
    : undefined;
};

const definedHits = (hits: ReadonlyArray<RateLimitHit | undefined>): RateLimitHit[] =>
  hits.filter((hit): hit is RateLimitHit => hit !== undefined);

const checkOf = (
  subject: RateLimitSubject,
  hits: ReadonlyArray<RateLimitHit | undefined>,
): ReadonlyArray<RateLimitCheck> => {
  const defined = definedHits(hits);
  return defined.length > 0 ? [{ subject, hits: defined }] : [];
};

const callerChecks = (
  policy: RateLimitPolicy,
  request: RateLimitRequest,
): ReadonlyArray<RateLimitCheck> => {
  const { caller, method, path } = request;
  if (caller.kind === "Anonymous" || !isApiPath(path)) {
    return [];
  }
  if (caller.kind === "Application") {
    return checkOf({ kind: "Token", tokenId: caller.tokenId }, [hitFor(policy, "api_token")]);
  }
  return checkOf({ kind: "Account", accountId: caller.accountId }, [
    hitFor(policy, "api_token", `api_token:${caller.tokenId}`),
    hitFor(policy, "api_account"),
    ...accountFamilies(method, path).map((bucket) => hitFor(policy, bucket)),
  ]);
};

/** The throttle a fixed window of `periodMs` is in at `nowMs`: its start and its end. */
const windowAt = (
  nowMs: number,
  periodMs: number,
): Readonly<{ startMs: number; endMs: number }> => {
  const startMs = Math.floor(nowMs / periodMs) * periodMs;
  return { startMs, endMs: startMs + periodMs };
};

const StoredCounterSchema = z.object({
  startMs: z.number(),
  periodMs: z.number().positive(),
  count: z.int().nonnegative(),
});

const CounterTableSchema = z.record(z.string(), StoredCounterSchema);

/** One subject's counters as stored: each counter's window start, window and count. */
export type RateLimitCounterTable = z.infer<typeof CounterTableSchema>;

export type RateLimitVerdict =
  /** Under every limit; `headline` is the counter with the least left, for the headers. */
  | Readonly<{ kind: "Allowed"; headline: RateLimitCounterState | undefined }>
  /** Over a limit; `headline` is the exceeded counter that resets last. */
  | Readonly<{ kind: "Limited"; headline: RateLimitCounterState; retryAfterSeconds: number }>;

const remaining = (state: RateLimitCounterState): number => Math.max(0, state.limit - state.count);

/**
 * The high-volume buckets an isolate may count on its own for a while
 * before it asks the shared counter (the `RateLimitCounter` Durable Object).
 * Every other bucket (the action families, sign-in, OAuth, app
 * registration) asks the shared counter on every hit: those requests are
 * rare, their windows are long or their limits small, and they are what an
 * abuser spends.
 */
const LOCAL_FIRST_BUCKETS: ReadonlySet<RateLimitBucket> = new Set([
  "api_ip",
  "api_token",
  "api_account",
  "federation_fetch",
  "inbox_ip",
  "inbox_domain",
]);

/**
 * One counter as one isolate has seen it in the current window: the hits it
 * counted (`seen`), those not yet sent to the shared counter (`unsent`), and
 * the count the shared counter last answered, every isolate's hits included
 * (`shared`, 0 before any answer).
 */
export type RateLimitLocalCount = Readonly<{ seen: number; unsent: number; shared: number }>;

/** The best count an isolate knows of for one counter in this window. */
const localEstimate = (local: RateLimitLocalCount): number =>
  Math.max(local.seen, local.shared + local.unsent);

/** An isolate counts alone up to a quarter of what the shared count last left. */
const LOCAL_SHARE_DIVISOR = 4;

export const RateLimit = {
  /**
   * The checks a request counts against, one per subject: its client
   * address (when known) for the address-keyed buckets, and its token or
   * account for the API buckets and the action families. Mastodon counts an
   * authenticated API request against the user and the token, not the
   * address, and does not exempt staff; neither does this.
   */
  checks: (policy: RateLimitPolicy, request: RateLimitRequest): ReadonlyArray<RateLimitCheck> => {
    const ipChecks =
      request.ip === undefined
        ? []
        : checkOf(
            { kind: "Ip", key: request.ip },
            ipBuckets(request.method, request.path, request.caller).map((bucket) =>
              hitFor(policy, bucket),
            ),
          );
    return [...ipChecks, ...callerChecks(policy, request)];
  },
  /**
   * The check for an inbox delivery whose signature verified, keyed on the
   * sending server, so unsigned or forged deliveries cannot spend a server's
   * budget.
   */
  inboxDomainCheck: (policy: RateLimitPolicy, host: string): RateLimitCheck | undefined => {
    const hit = hitFor(policy, "inbox_domain");
    return hit === undefined ? undefined : { subject: { kind: "RemoteDomain", host }, hits: [hit] };
  },
  localEstimate,
  /**
   * Whether an isolate may count one more hit on `hit`'s counter alone,
   * without asking the shared counter: only for `LOCAL_FIRST_BUCKETS`, and
   * only while the estimate stays within a quarter of the headroom the
   * shared counter last left (`shared + floor((limit - shared) / 4)`). A
   * client under a quarter of its limit costs no shared-counter call (hits
   * 1 to 75 of 300; the 76th asks, sending all 76); one that keeps going
   * asks again at about 44% and 58% of the limit, and near the limit the
   * quarter rounds to 0 so every hit asks and a single isolate holds it to
   * the limit exactly. A client spread over n isolates can get up to
   * (n - 1) quarters of the limit past it before the shared count refuses
   * it everywhere.
   */
  mayCountLocally: (hit: RateLimitHit, local: RateLimitLocalCount): boolean =>
    LOCAL_FIRST_BUCKETS.has(hit.bucket) &&
    localEstimate(local) + 1 <=
      local.shared + Math.floor(Math.max(0, hit.limit - local.shared) / LOCAL_SHARE_DIVISOR),
  window: windowAt,
  tableSchema: CounterTableSchema,
  parseTable: schemaResult(CounterTableSchema),
  /**
   * Count `hits` at `nowMs`: each counter in its current window goes up by
   * the hit's `by`, a counter whose window has passed starts again at `by`,
   * and windows that have ended are dropped from the table.
   */
  count: (
    table: RateLimitCounterTable,
    hits: ReadonlyArray<RateLimitIncrement>,
    nowMs: number,
  ): Readonly<{ table: RateLimitCounterTable; states: ReadonlyArray<RateLimitCounterState> }> => {
    const next: Record<string, z.infer<typeof StoredCounterSchema>> = {};
    for (const [name, stored] of Object.entries(table)) {
      if (stored.startMs + stored.periodMs > nowMs) {
        next[name] = stored;
      }
    }
    const states = hits.map((hit): RateLimitCounterState => {
      const window = windowAt(nowMs, hit.periodMs);
      const stored = next[hit.name];
      const count =
        stored !== undefined &&
        stored.startMs === window.startMs &&
        stored.periodMs === hit.periodMs
          ? stored.count + hit.by
          : hit.by;
      next[hit.name] = { startMs: window.startMs, periodMs: hit.periodMs, count };
      return { name: hit.name, limit: hit.limit, count, resetAtMs: window.endMs };
    });
    return { table: next, states };
  },
  /** When the last window in `table` ends, or `undefined` for an empty table. */
  expiresAtMs: (table: RateLimitCounterTable): number | undefined => {
    const ends = Object.values(table).map((stored) => stored.startMs + stored.periodMs);
    return ends.length > 0 ? Math.max(...ends) : undefined;
  },
  /** Whether the counters allow the request (Rack::Attack refuses once a count passes its limit). */
  verdict: (states: ReadonlyArray<RateLimitCounterState>, nowMs: number): RateLimitVerdict => {
    const exceeded = states.filter((state) => state.count > state.limit);
    const latest = exceeded.reduce<RateLimitCounterState | undefined>(
      (best, state) => (best === undefined || state.resetAtMs > best.resetAtMs ? state : best),
      undefined,
    );
    if (latest !== undefined) {
      return {
        kind: "Limited",
        headline: latest,
        retryAfterSeconds: Math.max(1, Math.ceil((latest.resetAtMs - nowMs) / 1000)),
      };
    }
    const headline = states.reduce<RateLimitCounterState | undefined>(
      (best, state) => (best === undefined || remaining(state) < remaining(best) ? state : best),
      undefined,
    );
    return { kind: "Allowed", headline };
  },
  remaining,
} as const;
