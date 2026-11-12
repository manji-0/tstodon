import {
  createExecutionContext,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { Hono } from "hono";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import { ApiError } from "@tstodon/api";
import {
  type HitRateLimitCounters,
  RateLimit,
  type RateLimitCounterTable,
  type RateLimitIncrement,
} from "@tstodon/domain";
import { expectContract } from "../test/api-contract";
import { accessTokenFor, authHeaders } from "../test/auth-fixture";
import { envWith } from "../test/env-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { generateAccountKeys } from "./keys";
import { signInboxRequest } from "./http-signature";
import {
  createRateLimiter,
  limitInboxDelivery,
  rateLimitMiddleware,
  rateLimitPolicy,
} from "./rate-limit";
import { postInbox } from "./routes/activitypub";

/**
 * Rate limits with the limits on (the test Worker runs with
 * `RATE_LIMITS_ENABLED=false`): an app with the middleware in front of a
 * route that answers `{ ok: true }`, counting in memory on a clock the test
 * moves. Each test uses its own addresses and accounts.
 */

const memoryCounters = () => {
  const tables = new Map<string, RateLimitCounterTable>();
  const calls: string[] = [];
  /** Each call's increments, as `name×by`. */
  const sent: string[][] = [];
  const counters: HitRateLimitCounters = async (subjectKey, hits, nowMs) => {
    calls.push(subjectKey);
    sent.push(hits.map((hit) => `${hit.name}×${hit.by}`));
    const { table, states } = RateLimit.count(tables.get(subjectKey) ?? {}, hits, nowMs);
    tables.set(subjectKey, table);
    return ok(states);
  };
  return { counters, calls, sent };
};

/** 2026-11-09T00:00:00Z: on every window boundary the tests use. */
const START_MS = Date.UTC(2026, 10, 9);

const limitedApp = (
  vars: Readonly<Record<string, string>> = {},
  counters?: HitRateLimitCounters,
  memory = memoryCounters(),
) => {
  const clock = { nowMs: START_MS };
  const limiter = createRateLimiter({
    counters: () => counters ?? memory.counters,
    now: () => clock.nowMs,
  });
  const app = new Hono<{ Bindings: Env }>();
  app.use(rateLimitMiddleware(limiter));
  app.all("*", (c) => c.json({ ok: true }));
  const testEnv = envWith({ RATE_LIMITS_ENABLED: "true", ...vars });
  const request = async (
    method: string,
    path: string,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<Response> =>
    app.request(
      `https://example.com${path}`,
      { method, headers },
      testEnv,
      createExecutionContext(),
    );
  return { request, clock, calls: memory.calls, sent: memory.sent };
};

const limits = (overrides: Record<string, unknown>): Record<string, string> => ({
  RATE_LIMITS: JSON.stringify(overrides),
});

const ip = (address: string) => ({ "CF-Connecting-IP": address });

const statuses = async (responses: ReadonlyArray<Promise<Response>>): Promise<number[]> =>
  (await Promise.all(responses)).map((response) => response.status);

/** `count` requests one after another, as their statuses. */
const repeat = async (count: number, send: () => Promise<Response>): Promise<number[]> => {
  const seen: number[] = [];
  for (let index = 0; index < count; index += 1) {
    seen.push((await send()).status);
  }
  return seen;
};

describe("rate limits on the API", () => {
  it("counts unauthenticated requests per address, with Mastodon's headers and 429", async () => {
    const { request } = limitedApp(limits({ api_ip: { limit: 3, period: 300 } }));
    const remaining: Array<string | null> = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await request("GET", "/api/v1/timelines/public", ip("198.51.100.1"));
      expect(response.status).toBe(200);
      expect(response.headers.get("X-RateLimit-Limit")).toBe("3");
      expect(response.headers.get("X-RateLimit-Reset")).toBe("2026-11-09T00:05:00.000Z");
      remaining.push(response.headers.get("X-RateLimit-Remaining"));
    }
    expect(remaining).toEqual(["2", "1", "0"]);

    const refused = await request("GET", "/api/v1/timelines/public", ip("198.51.100.1"));
    expect(refused.status).toBe(429);
    expect(expectContract(ApiError, await refused.json())).toEqual({
      error: "Too many requests",
    });
    expect(refused.headers.get("Retry-After")).toBe("300");
    expect(refused.headers.get("X-RateLimit-Limit")).toBe("3");
    expect(refused.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(refused.headers.get("X-RateLimit-Reset")).toBe("2026-11-09T00:05:00.000Z");

    // Another address has its own count; no address, no address-keyed limit.
    expect((await request("GET", "/api/v1/timelines/public", ip("198.51.100.2"))).status).toBe(200);
    const unknown = await request("GET", "/api/v1/timelines/public");
    expect(unknown.status).toBe(200);
    expect(unknown.headers.get("X-RateLimit-Limit")).toBeNull();
  });

  it("counts an IPv6 client's whole /64 together", async () => {
    const { request } = limitedApp(limits({ api_ip: { limit: 1, period: 300 } }));
    expect((await request("GET", "/api/v1/instance", ip("2001:db8:7:7::1"))).status).toBe(200);
    expect((await request("GET", "/api/v1/instance", ip("2001:db8:7:7::2"))).status).toBe(429);
    expect((await request("GET", "/api/v1/instance", ip("2001:db8:7:8::1"))).status).toBe(200);
  });

  it("allows again once the window has passed", async () => {
    const { request, clock } = limitedApp(limits({ api_ip: { limit: 1, period: 60 } }));
    const send = () => request("GET", "/api/v1/instance", ip("198.51.100.10"));
    expect(await statuses([send()])).toEqual([200]);
    clock.nowMs += 30_000;
    const refused = await send();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("30");
    clock.nowMs += 30_000;
    expect((await send()).status).toBe(200);
  });

  it("answers a known-over client without counting again until its window ends", async () => {
    const { request, calls, clock } = limitedApp(limits({ api_ip: { limit: 1, period: 60 } }));
    const send = () => request("GET", "/api/v1/instance", ip("198.51.100.11"));
    expect(await repeat(5, send)).toEqual([200, 429, 429, 429, 429]);
    expect(calls).toHaveLength(2);
    clock.nowMs += 60_000;
    expect((await send()).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("counts 75 of 300 in the isolate, then asks with all 76", async () => {
    const { request, calls, sent } = limitedApp();
    const send = () => request("GET", "/api/v1/instance", ip("198.51.100.12"));
    const remaining: Array<string | null> = [];
    for (let index = 0; index < 75; index += 1) {
      const response = await send();
      expect(response.status).toBe(200);
      expect(response.headers.get("X-RateLimit-Limit")).toBe("300");
      expect(response.headers.get("X-RateLimit-Reset")).toBe("2026-11-09T00:05:00.000Z");
      remaining.push(response.headers.get("X-RateLimit-Remaining"));
    }
    expect(remaining.slice(0, 2)).toEqual(["299", "298"]);
    expect(remaining.at(-1)).toBe("225");
    expect(calls).toHaveLength(0);
    const asked = await send();
    expect(asked.headers.get("X-RateLimit-Remaining")).toBe("224");
    expect(sent).toEqual([["api_ip×76"]]);
  });

  it("asks twice in a window for a client at half its limit", async () => {
    const { request, calls } = limitedApp();
    const send = () => request("GET", "/api/v1/instance", ip("198.51.100.16"));
    expect(new Set(await repeat(150, send))).toEqual(new Set([200]));
    expect(calls).toHaveLength(2);
  });

  it("holds a flood from one client to exactly its limit with few asks, until the next window", async () => {
    const { request, calls, clock } = limitedApp();
    const send = () => request("GET", "/api/v1/instance", ip("198.51.100.13"));
    const seen = await repeat(2000, send);
    expect(seen.filter((status) => status === 200)).toHaveLength(300);
    expect(seen.slice(300)).toEqual(Array.from({ length: 1700 }, () => 429));
    expect(calls.length).toBeLessThan(50);
    clock.nowMs += 300_000;
    expect((await send()).status).toBe(200);
  });

  it("holds a flood spread over four isolates to 1.75 times the limit", async () => {
    const memory = memoryCounters();
    const isolates = [1, 2, 3, 4].map(() => limitedApp({}, undefined, memory));
    const seen: number[] = [];
    for (let index = 0; index < 2000; index += 1) {
      const isolate = isolates[index % isolates.length];
      if (isolate !== undefined) {
        seen.push((await isolate.request("GET", "/api/v1/instance", ip("198.51.100.14"))).status);
      }
    }
    expect(seen.filter((status) => status === 200).length).toBeLessThanOrEqual(300 * 1.75);
    expect(seen.slice(-1000)).toEqual(Array.from({ length: 1000 }, () => 429));
  });

  it("asks on every hit of an abuse-sensitive family, with all of the subject's counters", async () => {
    const { request, calls, sent } = limitedApp();
    const headers = { ...(await authHeaders("ratelimit-strict@example.com")) };
    expect((await request("GET", "/api/v1/timelines/home", headers)).status).toBe(200);
    expect(calls).toHaveLength(0);
    expect((await request("POST", "/api/v1/statuses", headers)).status).toBe(200);
    expect((await request("POST", "/api/v1/statuses", headers)).status).toBe(200);
    expect(sent.map((names) => names.map((name) => name.replace(/:.*×/, "×")))).toEqual([
      ["api_token×2", "api_account×2", "statuses×1"],
      ["api_token×1", "api_account×1", "statuses×1"],
    ]);
    expect((await request("GET", "/auth/sign_in", ip("198.51.100.15"))).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("counts authenticated requests per token and per account, not per address", async () => {
    const { request } = limitedApp(
      limits({
        api_ip: { limit: 1, period: 300 },
        api_token: { limit: 2, period: 300 },
        api_account: { limit: 3, period: 300 },
      }),
    );
    const first = await authHeaders("ratelimit-token@example.com");
    const second = await authHeaders("ratelimit-token@example.com");
    const from = { ...ip("198.51.100.20") };
    const send = (headers: Record<string, string>) =>
      request("GET", "/api/v1/timelines/home", { ...headers, ...from });
    const ok1 = await send(first);
    expect(ok1.status).toBe(200);
    expect(ok1.headers.get("X-RateLimit-Limit")).toBe("2");
    expect(ok1.headers.get("X-RateLimit-Remaining")).toBe("1");
    expect((await send(first)).status).toBe(200);
    // The token is spent; the account's other token is not, until the account is.
    expect((await send(first)).status).toBe(429);
    expect((await send(second)).status).toBe(429);
    const other = await authHeaders("ratelimit-token-other@example.com");
    expect((await send(other)).status).toBe(200);
    // None of that counted against the address.
    expect((await request("GET", "/api/v1/instance", from)).status).toBe(200);
  });

  it("counts an app token per token, and a token that does not authenticate per address", async () => {
    const { request } = limitedApp(
      limits({ api_ip: { limit: 1, period: 300 }, api_token: { limit: 1, period: 300 } }),
    );
    const app = { Authorization: `Bearer ${await accessTokenFor(undefined)}` };
    expect((await request("GET", "/api/v1/instance", app)).status).toBe(200);
    expect((await request("GET", "/api/v1/instance", app)).status).toBe(429);
    const bogus = { Authorization: "Bearer not-a-token", ...ip("198.51.100.21") };
    expect((await request("GET", "/api/v1/instance", bogus)).status).toBe(200);
    expect((await request("GET", "/api/v1/instance", bogus)).status).toBe(429);
  });

  it("holds each account to Mastodon's action families", async () => {
    const families = [
      ["media", "POST", "/api/v2/media"],
      ["statuses", "POST", "/api/v1/statuses"],
      ["reblogs", "POST", "/api/v1/statuses/1/reblog"],
      ["follows", "POST", "/api/v1/accounts/1/follow"],
      ["reports", "POST", "/api/v1/reports"],
    ] as const;
    for (const [bucket, method, path] of families) {
      const { request } = limitedApp(limits({ [bucket]: { limit: 1, period: 1800 } }));
      const headers = await authHeaders(`ratelimit-${bucket}@example.com`);
      const allowed = await request(method, path, headers);
      expect(allowed.status, bucket).toBe(200);
      expect(allowed.headers.get("X-RateLimit-Limit"), bucket).toBe("1");
      expect((await request(method, path, headers)).status, bucket).toBe(429);
      // Reading is still allowed.
      expect((await request("GET", "/api/v1/timelines/home", headers)).status, bucket).toBe(200);
    }
  });
});

describe("rate limits keyed on the client address", () => {
  it("limits sign-in, OAuth, WebFinger, actor fetches and inbox deliveries", async () => {
    const cases = [
      ["sign_in", "GET", "/auth/sign_in"],
      ["sign_in", "POST", "/oauth/authorize"],
      ["oauth_token", "POST", "/oauth/token"],
      ["app_registration", "POST", "/api/v1/apps"],
      ["federation_fetch", "GET", "/.well-known/webfinger?resource=acct:a@example.com"],
      ["federation_fetch", "GET", "/users/alice"],
      ["inbox_ip", "POST", "/inbox"],
      ["inbox_ip", "POST", "/users/alice/inbox"],
    ] as const;
    let octet = 30;
    for (const [bucket, method, path] of cases) {
      octet += 1;
      const { request } = limitedApp(limits({ [bucket]: { limit: 1, period: 300 } }));
      const from = ip(`198.51.100.${octet}`);
      expect(await repeat(2, () => request(method, path, from)), path).toEqual([200, 429]);
      const refused = await request(method, path, from);
      expect(await refused.json(), path).toEqual({ error: "Too many requests" });
      // Mastodon sends the limit headers on every throttled response, and on
      // successful ones only for the API.
      expect(refused.headers.get("Retry-After"), path).toBe("300");
      expect(await repeat(1, () => request(method, path)), path).toEqual([200]);
    }
  });

  it("does not count the web app, the streaming socket or Better Auth", async () => {
    const { request } = limitedApp(
      limits({ api_ip: { limit: 1, period: 300 }, federation_fetch: { limit: 1, period: 300 } }),
    );
    const from = ip("198.51.100.60");
    for (const path of ["/home", "/@alice", "/api/v1/streaming", "/api/auth/get-session"]) {
      expect(await repeat(3, () => request("GET", path, from)), path).toEqual([200, 200, 200]);
    }
  });
});

describe("rate limit configuration", () => {
  it("is off with RATE_LIMITS_ENABLED=false, as in the test Worker", async () => {
    expect(rateLimitPolicy(env)).toBeUndefined();
    const { request } = limitedApp({
      RATE_LIMITS_ENABLED: "false",
      ...limits({ api_ip: { limit: 1, period: 300 } }),
    });
    const send = () => request("GET", "/api/v1/instance", ip("198.51.100.70"));
    expect(await repeat(3, send)).toEqual([200, 200, 200]);
    expect((await send()).headers.get("X-RateLimit-Limit")).toBeNull();
  });

  it("uses Mastodon's defaults, lifts a bucket set to false, and ignores a malformed value", async () => {
    const defaults = limitedApp();
    const response = await defaults.request("GET", "/api/v1/instance", ip("198.51.100.71"));
    expect(response.headers.get("X-RateLimit-Limit")).toBe("300");

    const lifted = limitedApp(limits({ api_ip: false }));
    const liftedResponse = await lifted.request("GET", "/api/v1/instance", ip("198.51.100.72"));
    expect(liftedResponse.status).toBe(200);
    expect(liftedResponse.headers.get("X-RateLimit-Limit")).toBeNull();

    const malformed = limitedApp({ RATE_LIMITS: '{"api_iq": false}' });
    const malformedResponse = await malformed.request(
      "GET",
      "/api/v1/instance",
      ip("198.51.100.73"),
    );
    expect(malformedResponse.headers.get("X-RateLimit-Limit")).toBe("300");
  });

  it("fails open when the counter cannot be reached", async () => {
    const down: HitRateLimitCounters = async () =>
      err({ kind: "RepositoryError", message: "down" });
    const { request } = limitedApp(limits({ api_ip: { limit: 1, period: 300 } }), down);
    const send = () => request("GET", "/api/v1/instance", ip("198.51.100.74"));
    expect(await repeat(3, send)).toEqual([200, 200, 200]);
  });
});

describe("RateLimitCounter (Durable Object)", () => {
  const hit: RateLimitIncrement = {
    name: "media",
    bucket: "media",
    limit: 2,
    periodMs: 60_000,
    by: 1,
  };

  it("counts per subject and keeps subjects apart", async () => {
    const namespace = env.RATE_LIMIT_COUNTER;
    const one = namespace.get(namespace.idFromName("test:do-one"));
    const two = namespace.get(namespace.idFromName("test:do-two"));
    const nowMs = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 1;
    const hourly = { ...hit, periodMs: 3_600_000 };
    expect((await one.hit([hourly], nowMs))[0]?.count).toBe(1);
    expect((await one.hit([hourly], nowMs))[0]?.count).toBe(2);
    const third = (await one.hit([hourly], nowMs))[0];
    expect(third).toEqual({ name: "media", limit: 2, count: 3, resetAtMs: nowMs - 1 + 3_600_000 });
    expect((await two.hit([hourly], nowMs))[0]?.count).toBe(1);
  });

  it("deletes its storage once the last window has ended", async () => {
    const namespace = env.RATE_LIMIT_COUNTER;
    const stub = namespace.get(namespace.idFromName("test:do-expiry"));
    // A window that ended an hour ago: the alarm finds nothing left.
    await stub.hit([hit], Date.now() - 3_600_000);
    await runDurableObjectAlarm(stub);
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.kv.get("counters"),
    );
    expect(stored).toBeUndefined();
  });

  it("keeps a window that has not ended through the sweep", async () => {
    const namespace = env.RATE_LIMIT_COUNTER;
    const stub = namespace.get(namespace.idFromName("test:do-sweep-live"));
    await stub.hit([{ ...hit, periodMs: 86_400_000 }], Date.now());
    await runDurableObjectAlarm(stub);
    expect((await stub.hit([{ ...hit, periodMs: 86_400_000 }], Date.now()))[0]?.count).toBe(2);
  });
});

describe("inbox deliveries per sending server", () => {
  const inboxApp = (host: string) => {
    const app = new Hono<{ Bindings: Env }>();
    app.post("/inbox", postInbox);
    const testEnv = envWith({
      RATE_LIMITS_ENABLED: "true",
      ...limits({ inbox_domain: { limit: 1, period: 86_400 } }),
    });
    return async (request: Request): Promise<number> => {
      const response = await app.request(request, undefined, testEnv, createExecutionContext());
      expect(response.status, host).not.toBe(500);
      return response.status;
    };
  };

  it("counts a server's deliveries in the isolate until a quarter of its limit", async () => {
    const memory = memoryCounters();
    const limiter = createRateLimiter({ counters: () => memory.counters, now: () => START_MS });
    const app = new Hono<{ Bindings: Env }>();
    app.post(
      "/inbox",
      async (c) => (await limitInboxDelivery(c, "busy.example", limiter)) ?? c.body(null, 202),
    );
    const testEnv = envWith({
      RATE_LIMITS_ENABLED: "true",
      ...limits({ inbox_domain: { limit: 40, period: 300 } }),
    });
    const deliver = async () =>
      app.request("https://example.com/inbox", { method: "POST" }, testEnv);
    expect(await repeat(10, deliver)).toEqual(Array.from({ length: 10 }, () => 202));
    expect(memory.calls).toEqual([]);
    expect((await deliver()).status).toBe(202);
    expect(memory.calls).toEqual(["domain:busy.example"]);
  });

  it("counts only deliveries whose signature verified, keyed on the signer's host", async () => {
    const host = "ratelimit-inbox.example";
    const remote = await remoteActor("sender", host);
    const send = inboxApp(host);
    const activity = (n: number) => ({
      id: `https://${host}/activities/${n}`,
      type: "Delete",
      object: `https://${host}/notes/${n}`,
    });

    // Forged deliveries in the sender's name do not spend its budget.
    const forger = await generateAccountKeys();
    for (const n of [1, 2, 3]) {
      const body = JSON.stringify({
        "@context": "https://www.w3.org/ns/activitystreams",
        actor: remote.actorUri,
        ...activity(n),
      });
      const headers = await signInboxRequest(
        new URL("https://example.com/inbox"),
        forger.privateKeyJwk,
        `${remote.actorUri}#main-key`,
        body,
      );
      const forged = new Request("https://example.com/inbox", {
        method: "POST",
        headers: headers._unsafeUnwrap(),
        body,
      });
      expect(await send(forged)).toBe(401);
    }

    expect(await send(await remote.delivery(activity(4)))).toBe(202);
    expect(await send(await remote.delivery(activity(5)))).toBe(429);
    // Another server is counted apart.
    const neighbour = await remoteActor("sender", "ratelimit-inbox-neighbour.example");
    expect(
      await send(
        await neighbour.delivery({
          id: "https://ratelimit-inbox-neighbour.example/activities/1",
          type: "Delete",
          object: "https://ratelimit-inbox-neighbour.example/notes/1",
        }),
      ),
    ).toBe(202);
  });
});
