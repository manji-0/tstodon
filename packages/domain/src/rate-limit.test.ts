import { describe, expect, it } from "vite-plus/test";
import { IpRange } from "./ip-block";
import {
  RateLimit,
  RateLimitPolicy,
  RateLimitSubject,
  isApiPath,
  type RateLimitCaller,
  type RateLimitCounterState,
  type RateLimitHit,
} from "./rate-limit";

const policy = RateLimitPolicy.defaults;
const anonymous: RateLimitCaller = { kind: "Anonymous" };
const account: RateLimitCaller = { kind: "Account", accountId: "acct-1", tokenId: "tok-1" };
const app: RateLimitCaller = { kind: "Application", tokenId: "tok-app" };

/** Each check as `subject key: counter names`. */
const checks = (
  method: string,
  path: string,
  caller: RateLimitCaller,
  ip: string | null = "203.0.113.5",
): ReadonlyArray<string> =>
  RateLimit.checks(policy, { method, path, ip: ip ?? undefined, caller }).map(
    (check) =>
      `${RateLimitSubject.key(check.subject)}: ${check.hits.map((hit) => hit.name).join(",")}`,
  );

describe("RateLimit.checks", () => {
  it("counts unauthenticated API requests per address only when one is known", () => {
    expect(checks("GET", "/api/v1/timelines/public", anonymous)).toEqual([
      "ip:203.0.113.5: api_ip",
    ]);
    expect(checks("GET", "/api/v1/timelines/public", anonymous, null)).toEqual([]);
  });

  it("counts authenticated API requests per token and per account, not per address", () => {
    expect(checks("GET", "/api/v1/timelines/home", account)).toEqual([
      "account:acct-1: api_token:tok-1,api_account",
    ]);
    expect(checks("GET", "/api/v1/instance", app)).toEqual(["token:tok-app: api_token"]);
  });

  it("adds Mastodon's RateLimiter families to the account's counters", () => {
    expect(checks("POST", "/api/v2/media", account)).toEqual([
      "account:acct-1: api_token:tok-1,api_account,media",
    ]);
    expect(checks("POST", "/api/v1/media", account)[0]).toContain(",media");
    expect(checks("POST", "/api/v1/statuses", account)[0]).toContain(",statuses");
    expect(checks("POST", "/api/v1/statuses/123/reblog", account)[0]).toContain(",reblogs");
    expect(checks("POST", "/api/v1/accounts/9/follow", account)[0]).toContain(",follows");
    expect(checks("POST", "/api/v1/reports", account)[0]).toContain(",reports");
    // Reading or editing is not posting.
    expect(checks("GET", "/api/v1/statuses", account)[0]).not.toContain("statuses");
    expect(checks("PUT", "/api/v1/statuses/1", account)[0]).not.toContain(",statuses");
    expect(checks("POST", "/api/v1/accounts/9/unfollow", account)[0]).not.toContain("follows");
  });

  it("keys sign-in, OAuth and federation buckets on the address", () => {
    expect(checks("GET", "/auth/sign_in", anonymous)).toEqual(["ip:203.0.113.5: sign_in"]);
    expect(checks("POST", "/oauth/authorize", account)).toEqual(["ip:203.0.113.5: sign_in"]);
    expect(checks("POST", "/oauth/token", anonymous)).toEqual(["ip:203.0.113.5: oauth_token"]);
    expect(checks("POST", "/api/v1/apps", anonymous)).toEqual([
      "ip:203.0.113.5: api_ip,app_registration",
    ]);
    for (const path of [
      "/.well-known/webfinger",
      "/.well-known/nodeinfo",
      "/nodeinfo/2.0",
      "/users/alice",
      "/users/alice/statuses/1",
      "/actor",
    ]) {
      expect(checks("GET", path, anonymous), path).toEqual(["ip:203.0.113.5: federation_fetch"]);
    }
    for (const path of ["/inbox", "/actor/inbox", "/users/alice/inbox"]) {
      expect(checks("POST", path, anonymous), path).toEqual(["ip:203.0.113.5: inbox_ip"]);
    }
  });

  it("leaves the streaming socket, Better Auth and the web app alone", () => {
    expect(isApiPath("/api/v1/streaming/user")).toBe(false);
    expect(isApiPath("/api/auth/get-session")).toBe(false);
    expect(checks("GET", "/api/v1/streaming", anonymous)).toEqual([]);
    expect(checks("GET", "/home", anonymous)).toEqual([]);
    expect(checks("GET", "/@alice", anonymous)).toEqual([]);
  });

  it("drops a bucket an override lifts and applies an override's numbers", () => {
    const custom = RateLimitPolicy.withOverrides({
      api_ip: false,
      media: { limit: 3, period: 60 },
    })._unsafeUnwrap();
    expect(
      RateLimit.checks(custom, {
        method: "GET",
        path: "/api/v1/instance",
        ip: "203.0.113.5",
        caller: anonymous,
      }),
    ).toEqual([]);
    const media = RateLimit.checks(custom, {
      method: "POST",
      path: "/api/v2/media",
      ip: undefined,
      caller: account,
    })[0]?.hits.find((hit) => hit.bucket === "media");
    expect(media).toEqual({ name: "media", bucket: "media", limit: 3, periodMs: 60_000 });
    // Untouched buckets keep Mastodon's numbers.
    expect(custom.statuses).toEqual({ kind: "Throttle", limit: 300, period: 10_800 });
  });
});

describe("RateLimitPolicy.withOverrides", () => {
  it("refuses unknown buckets and malformed rules", () => {
    expect(RateLimitPolicy.withOverrides({ api_iq: false }).isErr()).toBe(true);
    expect(RateLimitPolicy.withOverrides({ media: { limit: 0, period: 60 } }).isErr()).toBe(true);
    expect(RateLimitPolicy.withOverrides({ media: { limit: 3 } }).isErr()).toBe(true);
    expect(RateLimitPolicy.withOverrides({ media: true }).isErr()).toBe(true);
    expect(RateLimitPolicy.withOverrides([]).isErr()).toBe(true);
    expect(RateLimitPolicy.withOverrides({})._unsafeUnwrap()).toEqual(RateLimitPolicy.defaults);
  });

  it("has Mastodon's defaults", () => {
    const { defaults } = RateLimitPolicy;
    expect(defaults.api_ip).toEqual({ kind: "Throttle", limit: 300, period: 300 });
    expect(defaults.api_token).toEqual({ kind: "Throttle", limit: 300, period: 300 });
    expect(defaults.api_account).toEqual({ kind: "Throttle", limit: 1500, period: 300 });
    expect(defaults.media).toEqual({ kind: "Throttle", limit: 30, period: 1800 });
    expect(defaults.follows).toEqual({ kind: "Throttle", limit: 400, period: 86_400 });
  });
});

describe("RateLimit.inboxDomainCheck", () => {
  it("keys on the sending server, case-insensitively", () => {
    const check = RateLimit.inboxDomainCheck(policy, "Remote.Example");
    expect(check && RateLimitSubject.key(check.subject)).toBe("domain:remote.example");
    expect(check?.hits.map((hit) => hit.name)).toEqual(["inbox_domain"]);
    const lifted = RateLimitPolicy.withOverrides({ inbox_domain: false })._unsafeUnwrap();
    expect(RateLimit.inboxDomainCheck(lifted, "remote.example")).toBeUndefined();
  });
});

describe("RateLimit.count", () => {
  const hit: RateLimitHit = { name: "media", bucket: "media", limit: 2, periodMs: 60_000 };
  const other: RateLimitHit = { name: "statuses", bucket: "statuses", limit: 5, periodMs: 10_000 };

  it("counts within an epoch-aligned window and starts again in the next", () => {
    let table = {};
    const counts: number[] = [];
    for (const nowMs of [120_000, 130_000, 179_999, 180_000]) {
      const result = RateLimit.count(table, [hit], nowMs);
      table = result.table;
      counts.push(result.states[0]?.count ?? -1);
      expect(result.states[0]?.resetAtMs).toBe(nowMs < 180_000 ? 180_000 : 240_000);
    }
    expect(counts).toEqual([1, 2, 3, 1]);
  });

  it("keeps counters apart and drops windows that ended", () => {
    const first = RateLimit.count({}, [hit, other], 120_000);
    expect(first.states.map((state) => state.count)).toEqual([1, 1]);
    expect(RateLimit.expiresAtMs(first.table)).toBe(180_000);
    const later = RateLimit.count(first.table, [hit], 135_000);
    // `statuses` (a 10-second window ending at 130 000) is gone.
    expect(Object.keys(later.table)).toEqual(["media"]);
    expect(later.states[0]?.count).toBe(2);
    expect(RateLimit.expiresAtMs({})).toBeUndefined();
  });

  it("restarts a counter whose window length changed", () => {
    const first = RateLimit.count({}, [hit], 120_000);
    const resized = RateLimit.count(first.table, [{ ...hit, periodMs: 120_000 }], 125_000);
    expect(resized.states[0]?.count).toBe(1);
  });

  it("parses a stored table and refuses a malformed one", () => {
    const { table } = RateLimit.count({}, [hit], 120_000);
    expect(RateLimit.parseTable(JSON.parse(JSON.stringify(table)))._unsafeUnwrap()).toEqual(table);
    expect(RateLimit.parseTable({ media: { count: "x" } }).isErr()).toBe(true);
  });
});

describe("RateLimit.verdict", () => {
  const state = (name: string, limit: number, count: number, resetAtMs: number) =>
    ({ name, limit, count, resetAtMs }) satisfies RateLimitCounterState;

  it("allows up to the limit and names the counter with the least left", () => {
    const verdict = RateLimit.verdict(
      [state("a", 300, 10, 300_000), state("b", 30, 30, 1_800_000)],
      0,
    );
    expect(verdict).toEqual({ kind: "Allowed", headline: state("b", 30, 30, 1_800_000) });
    expect(RateLimit.verdict([], 0)).toEqual({ kind: "Allowed", headline: undefined });
  });

  it("refuses past the limit until the exceeded counter that resets last", () => {
    const verdict = RateLimit.verdict(
      [state("a", 300, 301, 300_000), state("b", 30, 31, 1_800_000), state("c", 5, 1, 9e9)],
      100_500,
    );
    expect(verdict).toEqual({
      kind: "Limited",
      headline: state("b", 30, 31, 1_800_000),
      retryAfterSeconds: 1700,
    });
    expect(RateLimit.remaining(state("b", 30, 31, 0))).toBe(0);
  });
});

describe("IpRange.throttleKey", () => {
  it("is the IPv4 address, and the /64 of an IPv6 address", () => {
    expect(IpRange.throttleKey("203.0.113.5")).toBe("203.0.113.5");
    expect(IpRange.throttleKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(IpRange.throttleKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(IpRange.throttleKey("2001:db8:1:2:bbbb::9")).toBe("2001:db8:1:2::/64");
    expect(IpRange.throttleKey("not an address")).toBeUndefined();
  });
});
