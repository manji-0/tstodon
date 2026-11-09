import { createExecutionContext, env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { envWith } from "../test/env-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import {
  createRefusalSampler,
  forgetInboxRefusalWindows,
  INBOX_REFUSAL_LOG_LIMIT,
  type InboxRefusalReason,
  recordInboxRefusal,
} from "./inbox-refusal";
import { createRateLimiter, rateLimitMiddleware } from "./rate-limit";
import { postInbox } from "./routes/activitypub";
import { ok } from "neverthrow";
import { RateLimit, type RateLimitCounterTable } from "@tstodon/domain";

/**
 * Every inbox refusal writes an `InboxRefused` event and an `inbox.refuse`
 * point (OPS-5). The inbox runs in this isolate (a Hono app around
 * `postInbox`) so the test controls the sampler's windows and sees the
 * metric points.
 */

type Point = Readonly<{ doubles: number[]; blobs: string[]; index: string }>;

const metricsEnv = (base: Env = env) => {
  const points: Point[] = [];
  const testEnv: Env = {
    ...base,
    METRICS: {
      writeDataPoint: (point) => {
        points.push({
          index: typeof point?.indexes?.[0] === "string" ? point.indexes[0] : "",
          doubles: [...(point?.doubles ?? [])],
          blobs: (point?.blobs ?? []).map(String),
        });
      },
    },
  };
  return { testEnv, refusals: () => points.filter((point) => point.index === "inbox.refuse") };
};

const inbox = (testEnv: Env) => {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/inbox", postInbox);
  return (request: Request) => app.request(request, undefined, testEnv, createExecutionContext());
};

type Spy = Readonly<{ mock: Readonly<{ calls: ReadonlyArray<ReadonlyArray<unknown>> }> }>;

const warnLines = (spy: Spy): Array<Record<string, unknown>> =>
  spy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes('"kind":"InboxRefus'))
    .map((line): Record<string, unknown> => JSON.parse(line));

const activity = (host: string, slug: string) => ({
  id: `https://${host}/activities/${slug}`,
  type: "Delete",
  object: `https://${host}/notes/${slug}`,
});

let warn: Spy;

beforeEach(() => {
  forgetInboxRefusalWindows();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // No remote answers: a key that is not cached cannot be fetched.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const expectRefusal = async (
  response: Response,
  status: number,
  reason: InboxRefusalReason,
  refusals: () => Point[],
  fields: Record<string, unknown> = {},
) => {
  expect(response.status, reason).toBe(status);
  const lines = warnLines(warn);
  expect(lines.at(-1), reason).toMatchObject({
    kind: "InboxRefused",
    reason,
    status,
    path: "/inbox",
    ...fields,
  });
  expect(refusals().at(-1), reason).toEqual({
    index: "inbox.refuse",
    doubles: [1, 1],
    blobs: [reason, String(status)],
  });
};

describe("inbox refusal events", () => {
  it("logs an unparseable body and a missing signature, with no body or header in the line", async () => {
    const { testEnv, refusals } = metricsEnv();
    const post = inbox(testEnv);
    await expectRefusal(
      await post(new Request("https://example.com/inbox", { method: "POST", body: "{not json" })),
      400,
      "UnparseableBody",
      refusals,
    );
    const bob = await remoteActor("refusal-unsigned", "refusal-unsigned.example");
    const signed = await bob.delivery(activity("refusal-unsigned.example", "1"));
    const body = await signed.text();
    await expectRefusal(
      await post(new Request("https://example.com/inbox", { method: "POST", body })),
      401,
      "MissingSignature",
      refusals,
      { actor: bob.actorUri },
    );
    const line = JSON.stringify(warnLines(warn));
    expect(line).not.toContain("refusal-unsigned.example/notes");
    expect(line).not.toContain("signature=");
  });

  it("logs a body that does not match its Digest", async () => {
    const { testEnv, refusals } = metricsEnv();
    const bob = await remoteActor("refusal-digest", "refusal-digest.example");
    const signed = await bob.delivery(activity("refusal-digest.example", "1"));
    const tampered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: JSON.stringify({ ...JSON.parse(await signed.text()), type: "Undo" }),
    });
    await expectRefusal(await inbox(testEnv)(tampered), 401, "DigestMismatch", refusals, {
      keyIdHost: "refusal-digest.example",
      actor: bob.actorUri,
    });
  });

  it("logs a signature that does not verify with the signer's cached key", async () => {
    const { testEnv, refusals } = metricsEnv();
    const host = "refusal-forged.example";
    // Same actor and key id, another key pair: the cached key is the second.
    const forger = await remoteActor("refusal-forged", host, { cache: false });
    await remoteActor("refusal-forged", host);
    await expectRefusal(
      await inbox(testEnv)(await forger.delivery(activity(host, "1"))),
      401,
      "SignatureMismatch",
      refusals,
      { keyIdHost: host },
    );
  });

  it("logs a key that belongs to another actor than the activity's", async () => {
    const { testEnv, refusals } = metricsEnv();
    const host = "refusal-mismatch.example";
    const mallory = await remoteActor("refusal-mallory", host);
    const alice = await remoteActor("refusal-alice", host);
    await expectRefusal(
      await inbox(testEnv)(
        await mallory.delivery({ ...activity(host, "1"), actor: alice.actorUri }),
      ),
      401,
      "ActorMismatch",
      refusals,
      { actor: alice.actorUri, keyIdHost: host },
    );
  });

  it("logs a key that cannot be fetched (404) and a key server that does not answer (503)", async () => {
    const { testEnv, refusals } = metricsEnv();
    const post = inbox(testEnv);
    const gone = await remoteActor("refusal-gone", "refusal-gone.example", { cache: false });
    await expectRefusal(
      await post(await gone.delivery(activity("refusal-gone.example", "1"))),
      401,
      "KeyRejected",
      refusals,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    const down = await remoteActor("refusal-down", "refusal-down.example", { cache: false });
    const response = await post(await down.delivery(activity("refusal-down.example", "1")));
    await expectRefusal(response, 503, "KeyUnavailable", refusals, {
      keyIdHost: "refusal-down.example",
    });
    expect(response.headers.get("Retry-After")).toBe("5");
  });

  it("logs an activity from a local actor that does not exist", async () => {
    const { testEnv, refusals } = metricsEnv();
    const bob = await remoteActor("refusal-local", "refusal-local.example");
    await expectRefusal(
      await inbox(testEnv)(
        await bob.delivery({
          ...activity("refusal-local.example", "1"),
          actor: "https://example.com/users/refusal-ghost",
        }),
      ),
      401,
      "UnknownLocalActor",
      refusals,
    );
  });

  it("refuses a suspended domain with 403 before fetching anything, cached or not", async () => {
    const { testEnv, refusals } = metricsEnv();
    const host = "refusal-suspended.example";
    await env.DB.prepare(
      "INSERT INTO domain_blocks (id, domain, severity) VALUES ('refusal-suspended', ?, 'suspend')",
    )
      .bind(host)
      .run();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const post = inbox(testEnv);
    const uncached = await remoteActor("refusal-new", host, { cache: false });
    await expectRefusal(
      await post(await uncached.delivery(activity(host, "1"))),
      403,
      "DomainSuspended",
      refusals,
      { keyIdHost: host },
    );
    const cached = await remoteActor("refusal-cached", host);
    await expectRefusal(
      await post(await cached.delivery(activity(host, "2"))),
      403,
      "DomainSuspended",
      refusals,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a domain outside the allow list with 403", async () => {
    const { testEnv, refusals } = metricsEnv(
      envWith({ FEDERATION_ALLOW_HOSTS: "allowed.example" }),
    );
    const bob = await remoteActor("refusal-limited", "refusal-limited.example");
    await expectRefusal(
      await inbox(testEnv)(await bob.delivery(activity("refusal-limited.example", "1"))),
      403,
      "DomainNotAllowed",
      refusals,
    );
  });

  it("refuses an admin-suspended actor with 403 and names the signer", async () => {
    const { testEnv, refusals } = metricsEnv();
    const bob = await remoteActor("refusal-actor", "refusal-actor.example");
    await env.DB.prepare(
      "INSERT INTO remote_actor_moderation (actor_uri, moderation) VALUES (?, 'Suspended')",
    )
      .bind(bob.actorUri)
      .run();
    await expectRefusal(
      await inbox(testEnv)(
        await bob.delivery({
          id: "https://refusal-actor.example/activities/like",
          type: "Like",
          object: "https://example.com/users/nobody/statuses/1",
        }),
      ),
      403,
      "ActorSuspended",
      refusals,
      { signer: bob.actorUri },
    );
  });

  it("logs a 429 for a server over its inbox_domain limit and an address over inbox_ip", async () => {
    const tables = new Map<string, RateLimitCounterTable>();
    const limiter = createRateLimiter({
      counters: () => async (subjectKey, hits, nowMs) => {
        const { table, states } = RateLimit.count(tables.get(subjectKey) ?? {}, hits, nowMs);
        tables.set(subjectKey, table);
        return ok(states);
      },
    });
    const { testEnv, refusals } = metricsEnv(
      envWith({
        RATE_LIMITS_ENABLED: "true",
        RATE_LIMITS: JSON.stringify({
          inbox_domain: { limit: 1, period: 86_400 },
          inbox_ip: { limit: 1, period: 300 },
        }),
      }),
    );
    const host = "refusal-throttled.example";
    const bob = await remoteActor("refusal-throttled", host);
    const post = inbox(testEnv);
    expect((await post(await bob.delivery(activity(host, "1")))).status).toBe(202);
    await expectRefusal(
      await post(await bob.delivery(activity(host, "2"))),
      429,
      "RateLimitedDomain",
      refusals,
      { signer: bob.actorUri },
    );

    const app = new Hono<{ Bindings: Env }>();
    app.use(rateLimitMiddleware(limiter));
    app.post("/inbox", (c) => c.body(null, 202));
    const fromAddress = () =>
      app.request(
        "https://example.com/inbox",
        { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.77" } },
        testEnv,
        createExecutionContext(),
      );
    expect((await fromAddress()).status).toBe(202);
    await expectRefusal(await fromAddress(), 429, "RateLimitedAddress", refusals);
  });
});

describe("inbox refusal sampling", () => {
  it("logs the first lines of a reason each minute and counts every refusal", async () => {
    const { testEnv, refusals } = metricsEnv();
    const post = inbox(testEnv);
    const unsigned = () =>
      post(
        new Request("https://example.com/inbox", {
          method: "POST",
          body: JSON.stringify({
            ...activity("refusal-flood.example", "1"),
            actor: "https://refusal-flood.example/users/flood",
          }),
        }),
      );
    for (let n = 0; n < INBOX_REFUSAL_LOG_LIMIT + 3; n += 1) {
      expect((await unsigned()).status).toBe(401);
    }
    // Another reason is not crowded out by the flood.
    await post(new Request("https://example.com/inbox", { method: "POST", body: "x" }));
    const lines = warnLines(warn);
    expect(lines.filter((line) => line.reason === "MissingSignature")).toHaveLength(
      INBOX_REFUSAL_LOG_LIMIT,
    );
    expect(lines.filter((line) => line.reason === "UnparseableBody")).toHaveLength(1);
    expect(
      refusals()
        .filter((point) => point.blobs[0] === "MissingSignature")
        .map((point) => point.doubles[1]),
    ).toEqual([1, 1, 1, 1, 1, 0, 0, 0]);
  });

  it("opens a new window after a minute and reports what the last one left unlogged", () => {
    const clock = { now: 1_000_000 };
    const sampler = createRefusalSampler(2, 60_000, () => clock.now);
    const admitted = () => sampler.admit("SignatureMismatch");
    expect([admitted(), admitted(), admitted(), admitted()]).toEqual([
      { log: true, suppressedBefore: 0 },
      { log: true, suppressedBefore: 0 },
      { log: false, suppressedBefore: 0 },
      { log: false, suppressedBefore: 0 },
    ]);
    expect(sampler.admit("KeyRejected")).toEqual({ log: true, suppressedBefore: 0 });
    clock.now += 59_999;
    expect(admitted()).toEqual({ log: false, suppressedBefore: 0 });
    clock.now += 1;
    expect(admitted()).toEqual({ log: true, suppressedBefore: 3 });
    expect(admitted()).toEqual({ log: true, suppressedBefore: 0 });
  });

  it("writes InboxRefusalsSuppressed before the first line of the next window", () => {
    const clock = { now: 0 };
    const sampler = createRefusalSampler(1, 60_000, () => clock.now);
    const { testEnv, refusals } = metricsEnv();
    const refusal = { reason: "KeyRejected", status: 401, path: "/inbox" } as const;
    recordInboxRefusal(testEnv, refusal, sampler);
    recordInboxRefusal(testEnv, refusal, sampler);
    recordInboxRefusal(testEnv, refusal, sampler);
    clock.now = 60_000;
    recordInboxRefusal(testEnv, refusal, sampler);
    expect(warnLines(warn).map((line) => [line.kind, line.suppressed])).toEqual([
      ["InboxRefused", undefined],
      ["InboxRefusalsSuppressed", 2],
      ["InboxRefused", undefined],
    ]);
    expect(refusals().map((point) => point.doubles)).toEqual([
      [1, 1],
      [1, 0],
      [1, 0],
      [1, 1],
    ]);
  });
});
