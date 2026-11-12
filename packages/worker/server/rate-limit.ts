import {
  type HitRateLimitCounters,
  IpRange,
  isApiPath,
  RateLimit,
  type RateLimitCaller,
  type RateLimitCheck,
  type RateLimitCounterState,
  type RateLimitHit,
  RateLimitPolicy,
  type RateLimitPolicyValue,
  RateLimitSubject,
  type RateLimitVerdict,
} from "@tstodon/domain";
import type { Context, Next } from "hono";
import { err, ok } from "neverthrow";
import { authenticate, bearerToken } from "./auth";
import { recordInboxRefusal } from "./inbox-refusal";
import { clientIp } from "./ip-access";
import { parseJsonText } from "./json-column";
import { optionalEnvString } from "./runtime-config";

/**
 * Enforcing rate limits (Mastodon's Rack::Attack throttles and `RateLimiter`
 * families; the policy is `RateLimit` in `@tstodon/domain`). Each subject a
 * request counts against (its client address, its token or account, a
 * sending server) has its counters in one `RateLimitCounter` Durable Object.
 * Each isolate counts the high-volume buckets on its own and calls the
 * Durable Object only once `RateLimit.mayCountLocally` says no, handing over the hits
 * it counted alone; the abuse-sensitive buckets call it on every hit. See
 * "Rate limits" in docs/reference/configuration.md.
 *
 * The limits fail open: a counter that cannot be reached lets the request
 * through, as a D1 outage must not lock every client out.
 */

/** Mastodon's `errors.429`. */
export const TOO_MANY_REQUESTS = "Too many requests";

const DISABLED_VALUES: ReadonlySet<string> = new Set(["false", "0", "off", "no"]);

let cachedOverrides: Readonly<{ raw: string; policy: RateLimitPolicyValue }> | undefined;

/**
 * The limits this deployment enforces, or `undefined` when
 * `RATE_LIMITS_ENABLED` turns them off. `RATE_LIMITS` (a JSON object of
 * bucket overrides) that does not parse leaves Mastodon's defaults in force.
 */
export const rateLimitPolicy = (env: Env): RateLimitPolicyValue | undefined => {
  if (DISABLED_VALUES.has(optionalEnvString(env, "RATE_LIMITS_ENABLED").trim().toLowerCase())) {
    return undefined;
  }
  const raw = optionalEnvString(env, "RATE_LIMITS").trim();
  if (raw.length === 0) {
    return RateLimitPolicy.defaults;
  }
  if (cachedOverrides?.raw === raw) {
    return cachedOverrides.policy;
  }
  const parsed = parseJsonText(raw).andThen(RateLimitPolicy.withOverrides);
  if (parsed.isErr()) {
    console.warn("RATE_LIMITS is not a JSON object of known buckets; using the defaults");
  }
  const policy = parsed.isOk() ? parsed.value : RateLimitPolicy.defaults;
  cachedOverrides = { raw, policy };
  return policy;
};

/** The counter contract on the `RATE_LIMIT_COUNTER` Durable Object namespace. */
export const durableObjectCounters =
  (namespace: Env["RATE_LIMIT_COUNTER"]): HitRateLimitCounters =>
  async (subjectKey, hits, nowMs) => {
    try {
      const stub = namespace.get(namespace.idFromName(subjectKey));
      const states: ReadonlyArray<RateLimitCounterState> = await stub.hit(hits, nowMs);
      return ok(states);
    } catch (cause) {
      return err({
        kind: "RepositoryError",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

/**
 * Counts checks and decides, counting in the isolate first and asking the
 * Durable Object as `RateLimit.mayCountLocally` says.
 */
export type RateLimiter = Readonly<{
  run: (env: Env, checks: ReadonlyArray<RateLimitCheck>) => Promise<RateLimitVerdict>;
}>;

/** This isolate's view of one counter in one window (see `RateLimitLocalCount`). */
type LocalCounter = {
  startMs: number;
  resetAtMs: number;
  seen: number;
  unsent: number;
  shared: number;
};

/** Counters remembered per isolate; beyond this many the least recently used go. */
const MAX_REMEMBERED = 10_000;

export const createRateLimiter = (
  options: Readonly<{
    counters?: (env: Env) => HitRateLimitCounters | undefined;
    now?: () => number;
  }> = {},
): RateLimiter => {
  // A Worker configured without the binding (the e2e instances) counts nothing.
  const countersFor =
    options.counters ??
    ((env: Env) =>
      "RATE_LIMIT_COUNTER" in env ? durableObjectCounters(env.RATE_LIMIT_COUNTER) : undefined);
  const now = options.now ?? Date.now;
  /** `subject key \n counter name` → its counter in the current window. */
  const local = new Map<string, LocalCounter>();

  const localCounter = (key: string, hit: RateLimitHit, nowMs: number): LocalCounter => {
    const window = RateLimit.window(nowMs, hit.periodMs);
    const known = local.get(key);
    local.delete(key);
    const counter =
      known !== undefined && known.startMs === window.startMs && known.resetAtMs === window.endMs
        ? known
        : { startMs: window.startMs, resetAtMs: window.endMs, seen: 0, unsent: 0, shared: 0 };
    local.set(key, counter);
    if (local.size > MAX_REMEMBERED) {
      const oldest = local.keys().next();
      if (!oldest.done) {
        local.delete(oldest.value);
      }
    }
    return counter;
  };

  const runCheck = async (
    counters: HitRateLimitCounters,
    check: RateLimitCheck,
    nowMs: number,
  ): Promise<ReadonlyArray<RateLimitCounterState>> => {
    const subjectKey = RateLimitSubject.key(check.subject);
    const counted = check.hits.map((hit) => ({
      hit,
      counter: localCounter(`${subjectKey}\n${hit.name}`, hit, nowMs),
    }));
    // A counter the Durable Object reported over stays refused here until its
    // window ends, so a flood from one client costs nothing more.
    const over = counted.find(({ hit, counter }) => counter.shared > hit.limit);
    if (over !== undefined) {
      const { hit, counter } = over;
      return [
        { name: hit.name, limit: hit.limit, count: counter.shared, resetAtMs: counter.resetAtMs },
      ];
    }
    const alone = counted.every(({ hit, counter }) => RateLimit.mayCountLocally(hit, counter));
    if (alone) {
      return counted.map(({ hit, counter }) => {
        counter.seen += 1;
        counter.unsent += 1;
        return {
          name: hit.name,
          limit: hit.limit,
          count: RateLimit.localEstimate(counter),
          resetAtMs: counter.resetAtMs,
        };
      });
    }
    // One ask carries every counter of the subject and every hit counted
    // alone; `unsent` is taken first so a concurrent request does not send it twice.
    const handed = counted.map(({ hit, counter }) => {
      const increment = { ...hit, by: counter.unsent + 1 };
      counter.seen += 1;
      counter.unsent = 0;
      return { counter, increment };
    });
    const shared = await counters(
      subjectKey,
      handed.map(({ increment }) => increment),
      nowMs,
    );
    if (shared.isErr()) {
      console.warn(`rate limit counter unavailable: ${shared.error.message}`);
      for (const { counter, increment } of handed) {
        counter.unsent += increment.by;
      }
      return [];
    }
    shared.value.forEach((state, index) => {
      const counter = handed[index]?.counter;
      if (counter !== undefined) {
        counter.shared = Math.max(counter.shared, state.count);
      }
    });
    return shared.value;
  };

  return {
    run: async (env, checks) => {
      const nowMs = now();
      const counters = countersFor(env);
      if (counters === undefined) {
        return { kind: "Allowed", headline: undefined };
      }
      const states = await Promise.all(checks.map((check) => runCheck(counters, check, nowMs)));
      return RateLimit.verdict(states.flat(), nowMs);
    },
  };
};

const defaultRateLimiter = createRateLimiter();

const rateLimitHeaders = (state: RateLimitCounterState): ReadonlyArray<[string, string]> => [
  ["X-RateLimit-Limit", String(state.limit)],
  ["X-RateLimit-Remaining", String(RateLimit.remaining(state))],
  ["X-RateLimit-Reset", new Date(state.resetAtMs).toISOString()],
];

/** Mastodon's throttled response: 429, `{"error":"Too many requests"}`, the limit headers and `Retry-After`. */
const tooManyRequests = <P extends string>(
  c: Context<{ Bindings: Env }, P>,
  verdict: Extract<RateLimitVerdict, { kind: "Limited" }>,
): Response => {
  for (const [name, value] of rateLimitHeaders(verdict.headline)) {
    c.header(name, value);
  }
  c.header("Retry-After", String(verdict.retryAfterSeconds));
  return c.json({ error: TOO_MANY_REQUESTS }, 429);
};

const setHeaders = (
  c: Context<{ Bindings: Env }, string>,
  headers: ReadonlyArray<[string, string]>,
): void => {
  try {
    for (const [name, value] of headers) {
      c.res.headers.set(name, value);
    }
  } catch {
    // A response with immutable headers (one passed through from `fetch`).
    const copy = new Response(c.res.body, c.res);
    for (const [name, value] of headers) {
      copy.headers.set(name, value);
    }
    c.res = copy;
  }
};

/**
 * Who an API request counts as: a valid token's account or app; no token, or
 * one that does not authenticate, counts as its address, as in Mastodon.
 */
const rateLimitCaller = async (
  request: Request,
  env: Env,
  path: string,
): Promise<RateLimitCaller> => {
  if (!isApiPath(path) || bearerToken(request) === undefined) {
    return { kind: "Anonymous" };
  }
  const auth = await authenticate(request, env);
  if (auth.isErr()) {
    return { kind: "Anonymous" };
  }
  switch (auth.value.kind) {
    case "Anonymous":
      return { kind: "Anonymous" };
    case "Application":
      return { kind: "Application", tokenId: auth.value.token.id };
    case "Account":
      return { kind: "Account", accountId: auth.value.account.id, tokenId: auth.value.token.id };
  }
};

/**
 * Request middleware (`app/middleware/02.rate-limit.ts`): count the request
 * against its buckets before routing, refuse it with 429 once one is over,
 * and send `X-RateLimit-*` on API responses, as Mastodon does. The client
 * address is `CF-Connecting-IP` only (see `clientIp`); without it no
 * address-keyed limit applies.
 */
export const rateLimitMiddleware =
  (limiter: RateLimiter = defaultRateLimiter) =>
  async (c: Context<{ Bindings: Env }, string>, next: Next): Promise<Response | void> => {
    const policy = rateLimitPolicy(c.env);
    if (policy === undefined) {
      return next();
    }
    const path = c.req.path;
    const address = clientIp(c.req.raw);
    const checks = RateLimit.checks(policy, {
      method: c.req.method,
      path,
      ip: address === undefined ? undefined : IpRange.throttleKey(address),
      caller: await rateLimitCaller(c.req.raw, c.env, path),
    });
    if (checks.length === 0) {
      return next();
    }
    const verdict = await limiter.run(c.env, checks);
    if (verdict.kind === "Limited") {
      if (verdict.headline.name === "inbox_ip") {
        recordInboxRefusal(c.env, { reason: "RateLimitedAddress", status: 429, path });
      }
      return tooManyRequests(c, verdict);
    }
    await next();
    if (verdict.headline !== undefined && isApiPath(path)) {
      setHeaders(c, rateLimitHeaders(verdict.headline));
    }
  };

/**
 * The `inbox_domain` limit for a delivery whose signature verified, keyed on
 * the server that signed it; a 429 when that server is over. Remote servers
 * retry a 429 later, so nothing is lost.
 */
export const limitInboxDelivery = async <P extends string>(
  c: Context<{ Bindings: Env }, P>,
  host: string,
  limiter: RateLimiter = defaultRateLimiter,
): Promise<Response | undefined> => {
  const policy = rateLimitPolicy(c.env);
  const check = policy === undefined ? undefined : RateLimit.inboxDomainCheck(policy, host);
  if (check === undefined) {
    return undefined;
  }
  const verdict = await limiter.run(c.env, [check]);
  return verdict.kind === "Limited" ? tooManyRequests(c, verdict) : undefined;
};
