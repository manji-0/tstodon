import { createExecutionContext, env, SELF } from "cloudflare:test";
import { Hono } from "hono";
import type { ApActivityDocumentOf } from "@tstodon/api/activitypub";
import {
  ActivityId,
  DELIVERY_MAX_ATTEMPTS,
  DeliveryAttemptOutcome,
  type DeliveryAttemptOutcomeValue,
  type DeliveryDomainHealthValue,
  Hostname,
  OutboxDelivery,
  type OutboxJob,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { authHeaders } from "../test/auth-fixture";
import { deliveredCreate } from "../test/delivery-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import {
  deliveryWorkflowId,
  enqueueInstanceActorActivity,
  type InboxDeliveryAttempt,
} from "./delivery";
import {
  deliveryDomainHealthDeps,
  findDeliveryDomainHealth,
  forgetDeliveryDomainHealthCache,
  recordInboxReachability,
} from "./delivery-domain-health-store";
import { type DeliverySteps, runOutboxDelivery } from "./outbox-delivery-run";
import { outboxDeliveryRunDeps } from "./outbox-delivery-workflow";
import { ensureOutboxTarget, ensureOutboxTargets, insertOutboundActivity } from "./outbox-store";
import { postInbox } from "./routes/activitypub";
import {
  type DeliveryWorkflowInstances,
  sweepStuckDeliveries,
  stuckDeliveryDeps,
} from "./stuck-delivery-sweep";

type DeliverTargetJob = Extract<OutboxJob, { kind: "DeliverTarget" }>;

const START = Date.parse("2026-11-02T08:00:00Z");

const TargetRowSchema = z.object({
  kind: z.string(),
  reason_kind: z.string().nullable(),
  attempt_count: z.number(),
  http_status: z.number().nullable(),
  next_attempt_at: z.string().nullable(),
});

const targetRow = async (job: DeliverTargetJob) => {
  const row = await env.DB.prepare(
    "SELECT kind, reason_kind, attempt_count, http_status, next_attempt_at FROM outbox_deliveries WHERE activity_id = ? AND inbox_url = ?",
  )
    .bind(job.activityId, job.inboxUrl)
    .first();
  const parsed = schemaResult(TargetRowSchema)(row);
  if (parsed.isErr()) {
    throw new Error("no target row");
  }
  return parsed.value;
};

/** An activity signed by the instance actor, and its target (not inserted). */
const deliveryJob = async (host: string): Promise<DeliverTargetJob> => {
  const inserted = await insertOutboundActivity(env.DB, {
    signer: { kind: "InstanceActor" },
    kind: "Flag",
    payload: { type: "Flag", id: `https://example.com/flags/${crypto.randomUUID()}` },
  });
  const activityId = ActivityId.parse(inserted._unsafeUnwrap().id)._unsafeUnwrap();
  return { kind: "DeliverTarget", activityId, inboxUrl: `https://${host}/inbox` };
};

/** {@link deliveryJob} with its target `Queued`, as fan-out leaves it. */
const queuedJob = async (host: string): Promise<DeliverTargetJob> => {
  const job = await deliveryJob(host);
  (await ensureOutboxTarget(env.DB, job.activityId, job.inboxUrl))._unsafeUnwrap();
  return job;
};

const scopeOf = (job: DeliverTargetJob) => ({ activityId: job.activityId, inboxUrl: null });

/** Workflow steps on a fake clock: a step runs at once, a sleep moves the clock. */
const fakeSteps = (clock: { now: number }, onSleep: () => Promise<void> = async () => {}) => {
  const names: string[] = [];
  const sleeps: number[] = [];
  const steps: DeliverySteps = {
    run: async (name, work) => {
      names.push(name);
      return work();
    },
    sleepUntil: async (name, atMs) => {
      names.push(name);
      sleeps.push(atMs - clock.now);
      await onSleep();
      clock.now = Math.max(clock.now, atMs);
    },
  };
  return { steps, names, sleeps };
};

/** Run deps answering each attempt from `outcomes` (the last repeats), at the fake clock. */
const runWith = (
  clock: { now: number },
  outcomes: ReadonlyArray<DeliveryAttemptOutcomeValue>,
  remote = true,
) => {
  const points: Array<Readonly<{ index: string; doubles: number[]; blobs: string[] }>> = [];
  let calls = 0;
  const deps = {
    ...outboxDeliveryRunDeps(env),
    prepare: async () => async (): Promise<InboxDeliveryAttempt> => {
      const outcome =
        outcomes[Math.min(calls, outcomes.length - 1)] ?? DeliveryAttemptOutcome.Success;
      calls += 1;
      return { outcome, remote };
    },
    recordReachability: (inboxUrl: string, reachability: "Reachable" | "Unreachable" | "Unknown") =>
      recordInboxReachability(env, inboxUrl, reachability, clock.now),
    metric: (index: string, doubles: ReadonlyArray<number>, blobs: ReadonlyArray<string>) => {
      points.push({ index, doubles: [...doubles], blobs: [...blobs] });
    },
    now: () => clock.now,
    random: () => 0,
  };
  return { deps, points, calls: () => calls };
};

const host = (name: string) => Hostname.ofAuthority(name);

const saveHealth = async (health: DeliveryDomainHealthValue) => {
  (await deliveryDomainHealthDeps(env.DB).save(health))._unsafeUnwrap();
  forgetDeliveryDomainHealthCache();
};

const unavailable = (domain: string): DeliveryDomainHealthValue => ({
  kind: "Unavailable",
  domain: host(domain),
  failureDays: 7,
  lastFailureDay: new Date().toISOString().slice(0, 10),
  unavailableSince: new Date().toISOString(),
});

const healthOf = async (domain: string) =>
  (await findDeliveryDomainHealth(env.DB, host(domain)))._unsafeUnwrap();

beforeEach(() => {
  forgetDeliveryDomainHealthCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("delivery retries", () => {
  it("retries a failing inbox 17 times on Sidekiq's backoff, then gives up and logs it", async () => {
    const job = await queuedJob("retry-down.example");
    const clock = { now: START };
    const { steps, sleeps, names } = fakeSteps(clock);
    const run = runWith(clock, [DeliveryAttemptOutcome.forHttpStatus(502)]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runOutboxDelivery(steps, run.deps, scopeOf(job));

    expect(result).toEqual({ kind: "Settled", rounds: 17 });
    expect(run.calls()).toBe(DELIVERY_MAX_ATTEMPTS);
    expect(sleeps).toEqual(
      Array.from({ length: 16 }, (_, count) => OutboxDelivery.backoffMs(count, 0)),
    );
    expect(sleeps[0]).toBe(15_000);
    expect((clock.now - START) / 3_600_000).toBeGreaterThan(49);
    expect(names.slice(0, 4)).toEqual([
      "round-0-chunk-0",
      "round-0-wait",
      "round-1-chunk-0",
      "round-1-wait",
    ]);
    expect(await targetRow(job)).toEqual({
      kind: "Failed",
      reason_kind: "RetryExhausted",
      attempt_count: 17,
      // The last attempt's status (OPS-5); the metric has every one.
      http_status: 502,
      next_attempt_at: null,
    });
    const givenUp = warn.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('"OutboxDeliveryGivenUp"'));
    expect(givenUp).toHaveLength(1);
    expect(JSON.parse(givenUp[0] ?? "{}")).toMatchObject({
      kind: "OutboxDeliveryGivenUp",
      reasonKind: "RetryExhausted",
      activityId: job.activityId,
      inboxUrl: job.inboxUrl,
      attempts: 17,
      lastOutcome: "http",
      httpStatus: 502,
    });
    // One point per attempt.
    const attempts = run.points.filter((point) => point.index === "outbox.deliver");
    expect(attempts).toHaveLength(17);
    expect(attempts[0]).toEqual({
      index: "outbox.deliver",
      doubles: [0, 502, 1],
      blobs: ["http", "retry-down.example"],
    });
    expect(attempts[16]?.doubles[2]).toBe(17);
    // The retries spanned three UTC days: three failure days for the domain.
    expect(await healthOf("retry-down.example")).toMatchObject({
      kind: "Failing",
      failureDays: 3,
    });
  });

  it("stores the next attempt time while the target waits", async () => {
    const job = await queuedJob("retry-later.example");
    const clock = { now: START };
    let rowWhileSleeping: z.infer<typeof TargetRowSchema> | undefined;
    const { steps, sleeps } = fakeSteps(clock, async () => {
      rowWhileSleeping ??= await targetRow(job);
    });
    const run = runWith(clock, [DeliveryAttemptOutcome.Network, DeliveryAttemptOutcome.Success]);
    expect(await runOutboxDelivery(steps, run.deps, scopeOf(job))).toEqual({
      kind: "Settled",
      rounds: 2,
    });
    expect(sleeps).toEqual([15_000]);
    expect(rowWhileSleeping).toEqual({
      kind: "Queued",
      reason_kind: null,
      attempt_count: 1,
      http_status: null,
      next_attempt_at: new Date(START + 15_000).toISOString(),
    });
    expect((await targetRow(job)).kind).toBe("Delivered");
  });

  it("stores a transient failure's HTTP status on the row while it waits, and clears it on success", async () => {
    const job = await queuedJob("retry-status.example");
    const clock = { now: START };
    const rows: Array<z.infer<typeof TargetRowSchema>> = [];
    const { steps } = fakeSteps(clock, async () => {
      rows.push(await targetRow(job));
    });
    const run = runWith(clock, [
      DeliveryAttemptOutcome.forHttpStatus(503),
      DeliveryAttemptOutcome.forHttpStatus(429, 1),
      DeliveryAttemptOutcome.Network,
      DeliveryAttemptOutcome.Success,
    ]);
    expect(await runOutboxDelivery(steps, run.deps, scopeOf(job))).toMatchObject({
      kind: "Settled",
    });
    expect(rows.map((row) => [row.kind, row.attempt_count, row.http_status])).toEqual([
      ["Queued", 1, 503],
      ["Queued", 2, 429],
      ["Queued", 3, null],
    ]);
    expect(await targetRow(job)).toMatchObject({ kind: "Delivered", http_status: null });
  });

  it("honours Retry-After on a 429", async () => {
    const job = await queuedJob("retry-throttled.example");
    const clock = { now: START };
    const { steps, sleeps } = fakeSteps(clock);
    const run = runWith(clock, [
      DeliveryAttemptOutcome.forHttpStatus(429, 1800),
      DeliveryAttemptOutcome.forHttpStatus(503, 1),
      DeliveryAttemptOutcome.Success,
    ]);
    expect(await runOutboxDelivery(steps, run.deps, scopeOf(job))).toMatchObject({
      kind: "Settled",
    });
    expect((await targetRow(job)).kind).toBe("Delivered");
    expect(sleeps).toEqual([1_800_000, OutboxDelivery.backoffMs(1, 0)]);
    expect(run.points.map((point) => point.blobs[0])).toEqual([
      "throttled",
      "throttled",
      "success",
    ]);
  });

  it("stops at a permanent failure without retrying", async () => {
    const job = await queuedJob("retry-gone.example");
    const clock = { now: START };
    const { steps, sleeps } = fakeSteps(clock);
    const run = runWith(clock, [DeliveryAttemptOutcome.forHttpStatus(410)]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runOutboxDelivery(steps, run.deps, scopeOf(job))).toEqual({
      kind: "Settled",
      rounds: 1,
    });
    expect(run.calls()).toBe(1);
    expect(sleeps).toEqual([]);
    expect(await targetRow(job)).toMatchObject({
      kind: "Failed",
      reason_kind: "Permanent",
      http_status: 410,
    });
    // The remote answered, so nothing is held against its domain.
    expect(await healthOf("retry-gone.example")).toBeUndefined();
  });

  it("carries on from the row's attempt count after a restart", async () => {
    const job = await queuedJob("retry-restarted.example");
    await env.DB.prepare(
      "UPDATE outbox_deliveries SET attempt_count = 15 WHERE activity_id = ? AND inbox_url = ?",
    )
      .bind(job.activityId, job.inboxUrl)
      .run();
    const clock = { now: START };
    const { steps } = fakeSteps(clock);
    const run = runWith(clock, [DeliveryAttemptOutcome.Network]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runOutboxDelivery(steps, run.deps, scopeOf(job))).toMatchObject({
      kind: "Settled",
    });
    expect(run.calls()).toBe(2);
    expect(await targetRow(job)).toMatchObject({
      kind: "Failed",
      reason_kind: "RetryExhausted",
      attempt_count: 17,
    });
  });

  it("does not hold a local failure against the remote", async () => {
    const job = await queuedJob("retry-local.example");
    const clock = { now: START };
    const { steps } = fakeSteps(clock);
    const run = runWith(
      clock,
      [DeliveryAttemptOutcome.Local, DeliveryAttemptOutcome.Success],
      false,
    );
    expect(await runOutboxDelivery(steps, run.deps, scopeOf(job))).toMatchObject({
      kind: "Settled",
    });
    expect((await targetRow(job)).kind).toBe("Delivered");
    expect(await healthOf("retry-local.example")).toBeUndefined();
  });
});

describe("delivery to many inboxes", () => {
  it("attempts ten inboxes to a step and retries only the failed ones in the next round", async () => {
    const job = await queuedJob("many-00.example");
    const inboxes = Array.from(
      { length: 12 },
      (_, i) => `https://many-${String(i).padStart(2, "0")}.example/inbox`,
    );
    (await ensureOutboxTargets(env.DB, job.activityId, inboxes))._unsafeUnwrap();
    const clock = { now: START };
    const { steps, names } = fakeSteps(clock);
    const posted: string[] = [];
    const deps = {
      ...runWith(clock, [DeliveryAttemptOutcome.Success]).deps,
      prepare:
        async () =>
        async (inboxUrl: string): Promise<InboxDeliveryAttempt> => {
          posted.push(inboxUrl);
          const failing = inboxUrl.includes("many-03") || inboxUrl.includes("many-11");
          const first = posted.filter((url) => url === inboxUrl).length === 1;
          return {
            outcome:
              failing && first
                ? DeliveryAttemptOutcome.forHttpStatus(503)
                : DeliveryAttemptOutcome.Success,
            remote: true,
          };
        },
    };
    expect(await runOutboxDelivery(steps, deps, scopeOf(job))).toEqual({
      kind: "Settled",
      rounds: 2,
    });
    expect(names).toEqual([
      "round-0-chunk-0",
      "round-0-chunk-1",
      "round-0-wait",
      "round-1-chunk-0",
    ]);
    expect(posted).toHaveLength(14);
    expect(posted.slice(12).toSorted()).toEqual([inboxes[3], inboxes[11]]);
    for (const inboxUrl of inboxes) {
      expect((await targetRow({ ...job, inboxUrl })).kind).toBe("Delivered");
    }
  });

  it("does not post again to a target a failed step already settled", async () => {
    const job = await queuedJob("rerun.example");
    const clock = { now: START };
    const names: string[] = [];
    const steps: DeliverySteps = {
      run: async (name, work) => {
        names.push(name);
        try {
          return await work();
        } catch {
          return work();
        }
      },
      sleepUntil: async () => {},
    };
    const run = runWith(clock, [DeliveryAttemptOutcome.Success]);
    let failures = 0;
    const deps = {
      ...run.deps,
      nextDue: async (scope: Readonly<{ activityId: string; inboxUrl: string | null }>) => {
        if (failures === 0) {
          failures += 1;
          throw new Error("D1 unavailable");
        }
        return run.deps.nextDue(scope);
      },
    };
    expect(await runOutboxDelivery(steps, deps, scopeOf(job))).toEqual({
      kind: "Settled",
      rounds: 1,
    });
    expect(run.calls()).toBe(1);
    expect((await targetRow(job)).kind).toBe("Delivered");
  });

  it("delivers only its own inbox in an instance started for one inbox", async () => {
    const job = await queuedJob("legacy-mine.example");
    const other = "https://legacy-other.example/inbox";
    (await ensureOutboxTargets(env.DB, job.activityId, [other]))._unsafeUnwrap();
    const clock = { now: START };
    const { steps } = fakeSteps(clock);
    const run = runWith(clock, [DeliveryAttemptOutcome.Success]);
    expect(
      await runOutboxDelivery(steps, run.deps, {
        activityId: job.activityId,
        inboxUrl: job.inboxUrl,
      }),
    ).toEqual({ kind: "Settled", rounds: 1 });
    expect((await targetRow(job)).kind).toBe("Delivered");
    expect((await targetRow({ ...job, inboxUrl: other })).kind).toBe("Queued");
  });
});

describe("unavailable domains", () => {
  it("are marked after failures on seven days and cleared by a delivery", async () => {
    const domain = "health-seven.example";
    const day = 24 * 3_600_000;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 6; i += 1) {
      await recordInboxReachability(env, `https://${domain}/inbox`, "Unreachable", START + i * day);
    }
    expect(await healthOf(domain)).toMatchObject({ kind: "Failing", failureDays: 6 });
    await recordInboxReachability(env, `https://${domain}/inbox`, "Unreachable", START + 6 * day);
    expect(await healthOf(domain)).toMatchObject({ kind: "Unavailable", failureDays: 7 });
    expect(
      warn.mock.calls.some(([line]) => String(line).includes('"kind":"DeliveryDomainUnavailable"')),
    ).toBe(true);

    await recordInboxReachability(env, `https://${domain}/users/x/inbox`, "Reachable");
    expect(await healthOf(domain)).toBeUndefined();
    const available = log.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes('"kind":"DeliveryDomainAvailable"'));
    expect(JSON.parse(available ?? "{}")).toMatchObject({
      domain,
      failureDays: 7,
      via: "delivery",
    });
  });

  it("skip a targeted delivery, recording the target as Skipped", async () => {
    await saveHealth(unavailable("skip-targeted.example"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const inbox = "https://skip-targeted.example/inbox";
    const flag: ApActivityDocumentOf<"Flag"> = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `https://example.com/actor#${crypto.randomUUID()}`,
      type: "Flag",
      actor: "https://example.com/actor",
      content: "",
      object: ["https://skip-targeted.example/users/someone"],
    };
    expect((await enqueueInstanceActorActivity(env, "Flag", flag, inbox)).isOk()).toBe(true);
    const row = await env.DB.prepare(
      `SELECT d.kind, d.reason_kind FROM outbound_activities a JOIN outbox_deliveries d ON d.activity_id = a.id
       WHERE d.inbox_url = ? AND instr(a.payload_json, ?) > 0`,
    )
      .bind(inbox, flag.id)
      .first();
    expect(row).toEqual({ kind: "Skipped", reason_kind: "DomainUnavailable" });
  });

  it("skip an attempt when the domain became unavailable during the retries", async () => {
    const job = await queuedJob("skip-midway.example");
    const clock = { now: START };
    const { steps } = fakeSteps(clock);
    const run = runWith(clock, [DeliveryAttemptOutcome.Network]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await saveHealth(unavailable("skip-midway.example"));
    expect(await runOutboxDelivery(steps, run.deps, scopeOf(job))).toEqual({
      kind: "Settled",
      rounds: 1,
    });
    expect(run.calls()).toBe(0);
    expect(run.points.map((point) => point.blobs[0])).toEqual(["skipped"]);
    expect((await targetRow(job)).kind).toBe("Skipped");
  });

  it("skip follower inboxes at fan-out, and are cleared by an inbound activity", async () => {
    const domain = "skip-fanout.example";
    const email = "skip-fanout@example.com";
    const account = z.object({ username: z.string(), id: z.string() }).parse(
      await (
        await SELF.fetch("https://example.com/api/v1/accounts/verify_credentials", {
          headers: await authHeaders(email),
        })
      ).json(),
    );
    // A failing record, then a verified activity from the domain: it is cleared.
    await saveHealth({
      kind: "Failing",
      domain: host(domain),
      failureDays: 3,
      lastFailureDay: new Date().toISOString().slice(0, 10),
    });
    const follower = await remoteActor("skip-fanout-follower", domain);
    vi.spyOn(console, "log").mockImplementation(() => {});
    // A Like of a note that is not here: it queues no delivery back. Posted
    // to the inbox handler in this isolate, whose domain health copy the
    // test controls (the Worker's own copy may be a minute old).
    const inboxApp = new Hono<{ Bindings: Env }>();
    inboxApp.post("/inbox", postInbox);
    await inboxApp.request(
      await follower.delivery({
        id: `${follower.actorUri}/likes/${crypto.randomUUID()}`,
        type: "Like",
        actor: follower.actorUri,
        object: "https://example.com/users/nobody/statuses/1",
      }),
      undefined,
      env,
      createExecutionContext(),
    );
    expect(await healthOf(domain)).toBeUndefined();
    await env.DB.prepare(
      `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind)
       VALUES (?, ?, ?, 'Fulfilled', 'Accepted')`,
    )
      .bind(crypto.randomUUID(), follower.actorUri, account.id)
      .run();

    await saveHealth(unavailable(domain));
    const posted = await SELF.fetch("https://example.com/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({ status: "while they are down", visibility: "public" }),
    });
    const uri = z.object({ uri: z.string() }).parse(await posted.json()).uri;
    const created = await deliveredCreate(account.id, uri);
    const inbox = `${follower.actorUri}/inbox`;
    expect(created?.inboxes).toContain(inbox);
    const row = await env.DB.prepare(
      `SELECT d.kind, d.reason_kind FROM outbox_deliveries d JOIN outbound_activities a ON a.id = d.activity_id
       WHERE d.inbox_url = ? AND a.kind = 'Create' AND a.account_id = ?`,
    )
      .bind(inbox, account.id)
      .first();
    expect(row).toEqual({ kind: "Skipped", reason_kind: "DomainUnavailable" });
  });
});

describe("stuck-delivery sweep", () => {
  const overdue = async (job: DeliverTargetJob, createdAt: string, dueAt: string | null) => {
    await env.DB.prepare(
      `INSERT INTO outbox_deliveries (id, activity_id, kind, attempt_count, inbox_url, created_at, updated_at, next_attempt_at)
       VALUES (?, ?, 'Queued', 3, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), job.activityId, job.inboxUrl, createdAt, createdAt, dueAt)
      .run();
  };

  const fakeWorkflows = (states: Readonly<Record<string, string>>) => {
    const created: string[] = [];
    const restarted: string[] = [];
    const workflows: DeliveryWorkflowInstances = {
      create: async ({ params }) => {
        created.push(params.activityId);
      },
      get: async (id) => {
        const status = states[id];
        if (status === undefined) {
          throw new Error("instance.not_found");
        }
        return {
          status: async () => ({ status }),
          restart: async () => {
            restarted.push(id);
          },
        };
      },
    };
    return { workflows, created, restarted };
  };

  it("starts a Workflow that never started, restarts an errored one, and gives up an ancient one", async () => {
    // Ten minutes ahead of the clock, so targets other tests left due just
    // now are not overdue by an hour.
    const now = Date.now() + 10 * 60_000;
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const never = await deliveryJob("sweep-never.example");
    const errored = await deliveryJob("sweep-errored.example");
    const sleeping = await deliveryJob("sweep-sleeping.example");
    const ancient = await deliveryJob("sweep-ancient.example");
    const fresh = await deliveryJob("sweep-fresh.example");
    await overdue(never, at(180), null);
    await overdue(errored, at(24 * 60), at(120));
    await overdue(sleeping, at(24 * 60), at(90));
    await overdue(ancient, at(11 * 24 * 60), at(9 * 24 * 60));
    // Due 30 minutes ago: within the grace, not looked at.
    await overdue(fresh, at(180), at(30));
    const { workflows, created, restarted } = fakeWorkflows({
      [await deliveryWorkflowId(errored.activityId)]: "errored",
      [await deliveryWorkflowId(sleeping.activityId)]: "waiting",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const swept = await sweepStuckDeliveries(env, stuckDeliveryDeps(env, workflows), now);

    expect(swept._unsafeUnwrap()).toMatchObject({ restarted: 1, waiting: 1, givenUp: 1 });
    expect(created).toContain(never.activityId);
    expect(restarted).toEqual([await deliveryWorkflowId(errored.activityId)]);
    expect(await targetRow(never)).toMatchObject({
      kind: "Queued",
      next_attempt_at: new Date(now).toISOString(),
    });
    expect(await targetRow(sleeping)).toMatchObject({
      kind: "Queued",
      next_attempt_at: new Date(now).toISOString(),
    });
    expect(await targetRow(ancient)).toMatchObject({
      kind: "Failed",
      reason_kind: "RetryExhausted",
      attempt_count: 3,
    });
    expect(await targetRow(fresh)).toMatchObject({ next_attempt_at: at(30) });
    expect(
      warn.mock.calls.some(
        ([line]) =>
          String(line).includes('"OutboxDeliveryGivenUp"') && String(line).includes('"Stuck"'),
      ),
    ).toBe(true);
    expect(log.mock.calls.some(([line]) => String(line).includes('"OutboxDeliverySweep"'))).toBe(
      true,
    );

    // Postponed: the next sweep an hour later does not look at them again yet.
    const again = await sweepStuckDeliveries(env, stuckDeliveryDeps(env, workflows), now + 1000);
    expect(again._unsafeUnwrap().examined).toBe(0);
  });
});
