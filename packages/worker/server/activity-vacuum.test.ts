import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { ActivityVacuum } from "@tstodon/domain";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { signedInAccount } from "../test/auth-fixture";
import { vacuumActivities } from "./activity-vacuum";
import { inboxActivityState } from "./inbox-store";
import { processOutboxJob } from "./outbox-job";
import { handleScheduled } from "./scheduled-handler";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const DAY_MS = 24 * 60 * 60 * 1000;

/** A clock in 2001, so nothing the other tests write (at today's date) is past any cutoff. */
const NOW = Date.parse("2001-06-01T00:00:00.000Z");
const OLD = "2001-01-01T00:00:00.000Z";
const at = (daysBeforeNow: number): string => new Date(NOW - daysBeforeNow * DAY_MS).toISOString();

const QUEUED: QueueSendResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
};

/** An 18-digit id under every real one, ordered by `n`. */
const fixedId = (prefix: number, n: number): string =>
  `${String(prefix).padStart(6, "0")}${String(n).padStart(12, "0")}`;

const withVars = (vars: Readonly<Record<string, string>>): Env =>
  new Proxy(env, {
    get: (target, key) =>
      typeof key === "string" && key in vars ? vars[key] : Reflect.get(target, key),
  });

const insertDelivery = (
  id: string,
  activityId: string,
  kind: string,
  inboxUrl: string | null,
  updatedAt: string,
  reasonKind: string | null = null,
) =>
  env.DB.prepare(
    `INSERT INTO outbox_deliveries
       (id, activity_id, kind, reason_kind, attempt_count, inbox_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
  ).bind(id, activityId, kind, reasonKind, inboxUrl, updatedAt, updatedAt);

const insertActivity = (
  id: string,
  accountId: string | null,
  kind: string,
  payload: unknown,
  createdAt: string,
) =>
  env.DB.prepare(
    `INSERT INTO outbound_activities (id, account_id, kind, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, accountId, kind, JSON.stringify(payload), createdAt);

const ids = async (sql: string, ...binds: ReadonlyArray<string>): Promise<string[]> => {
  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all();
  return z
    .array(z.object({ id: z.string() }))
    .parse(results)
    .map((row) => row.id);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the activity vacuum", () => {
  it("deletes finished deliveries past retention and keeps every unfinished one", async () => {
    const activity = "vacuum-deliveries";
    await env.DB.batch([
      insertDelivery("vd-delivered-old", activity, "Delivered", "https://a.example/inbox", OLD),
      insertDelivery(
        "vd-permanent-old",
        activity,
        "Failed",
        "https://b.example/inbox",
        OLD,
        "Permanent",
      ),
      insertDelivery(
        "vd-exhausted-old",
        activity,
        "Failed",
        "https://c.example/inbox",
        OLD,
        "RetryExhausted",
      ),
      insertDelivery("vd-fanout-old", activity, "Expanded", null, OLD),
      // Skipped because its domain was unavailable: final, like Delivered.
      insertDelivery(
        "vd-skipped-old",
        activity,
        "Skipped",
        "https://g.example/inbox",
        OLD,
        "DomainUnavailable",
      ),
      insertDelivery("vd-queued-old", activity, "Queued", "https://d.example/inbox", OLD),
      // A state a later build may add (a delivery waiting for a host to come back).
      insertDelivery("vd-unknown-old", activity, "Deferred", "https://e.example/inbox", OLD),
      insertDelivery(
        "vd-delivered-recent",
        activity,
        "Delivered",
        "https://f.example/inbox",
        at(29),
      ),
    ]);
    const pass = await vacuumActivities(env, NOW);
    expect(pass._unsafeUnwrap()).toMatchObject({ deliveries: 5, chained: false });
    expect(
      await ids("SELECT id FROM outbox_deliveries WHERE activity_id = ? ORDER BY id", activity),
    ).toEqual(["vd-delivered-recent", "vd-queued-old", "vd-unknown-old"]);
  });

  it("keeps the outbound activities a delivery or the outbox still reads", async () => {
    const account = await signedInAccount("vacuum-outbox@example.com");
    const prefix = 1;
    const note = (n: number, to: ReadonlyArray<string>) => ({
      type: "Create",
      id: `https://example.com/users/${account.username}/statuses/${n}/activity`,
      object: { type: "Note", id: `https://example.com/n/${n}`, to, cc: [] },
    });
    const publicCount = ActivityVacuum.keepOutboxItems + 5;
    const statements = [
      // Old public notes, oldest first: the newest 40 are the outbox page.
      ...Array.from({ length: publicCount }, (_, n) =>
        insertActivity(fixedId(prefix, n), account.id, "Create", note(n, [PUBLIC]), OLD),
      ),
      ...Array.from({ length: publicCount }, (_, n) =>
        insertDelivery(`vo-fanout-${n}`, fixedId(prefix, n), "Expanded", null, OLD),
      ),
      // Newer by id, but followers-only: not on the outbox page, so not kept for it.
      insertActivity(
        fixedId(prefix, 100),
        account.id,
        "Create",
        note(100, [`https://example.com/users/${account.username}/followers`]),
        OLD,
      ),
      insertActivity(fixedId(prefix, 101), account.id, "Follow", { type: "Follow" }, OLD),
      insertDelivery("vo-follow-fanout", fixedId(prefix, 101), "Expanded", null, OLD),
      insertDelivery(
        "vo-follow-target",
        fixedId(prefix, 101),
        "Delivered",
        "https://r.example/inbox",
        OLD,
      ),
      // Still being delivered to one inbox.
      insertActivity(fixedId(prefix, 102), account.id, "Like", { type: "Like" }, OLD),
      insertDelivery("vo-like-fanout", fixedId(prefix, 102), "Expanded", null, OLD),
      insertDelivery(
        "vo-like-target",
        fixedId(prefix, 102),
        "Queued",
        "https://r.example/inbox",
        OLD,
      ),
      // Never expanded yet.
      insertActivity(fixedId(prefix, 103), account.id, "Update", { type: "Update" }, OLD),
      insertDelivery("vo-update-fanout", fixedId(prefix, 103), "Queued", null, OLD),
      // Inside the retention window.
      insertActivity(fixedId(prefix, 104), account.id, "Follow", { type: "Follow" }, at(10)),
      // Signed by the instance actor.
      insertActivity(fixedId(prefix, 105), null, "Delete", { type: "Delete" }, OLD),
    ];
    await env.DB.batch(statements);

    const pass = await vacuumActivities(env, NOW);
    expect(pass._unsafeUnwrap().chained).toBe(false);
    const left = await ids(
      "SELECT id FROM outbound_activities WHERE id LIKE ? ORDER BY id",
      `${String(prefix).padStart(6, "0")}%`,
    );
    expect(left).toEqual([
      ...Array.from({ length: ActivityVacuum.keepOutboxItems }, (_, n) => fixedId(prefix, n + 5)),
      fixedId(prefix, 102),
      fixedId(prefix, 103),
      fixedId(prefix, 104),
    ]);

    // The outbox still renders a full page, newest first.
    const response = await SELF.fetch(
      `https://example.com/users/${account.username}/outbox?limit=40`,
    );
    expect(response.status).toBe(200);
    const outbox = z
      .object({ orderedItems: z.array(z.object({ id: z.string() })) })
      .parse(await response.json());
    expect(outbox.orderedItems).toHaveLength(ActivityVacuum.keepOutboxItems);
    expect(outbox.orderedItems[0]?.id).toBe(note(publicCount - 1, [PUBLIC]).id);

    // A second pass finds nothing more to do.
    expect((await vacuumActivities(env, NOW))._unsafeUnwrap()).toMatchObject({
      outbound: 0,
      chained: false,
    });
  });

  it("keeps received activity ids long enough to dedupe a redelivery", async () => {
    const insert = (id: string, createdAt: string, state: string = "Processed") =>
      env.DB.prepare(
        "INSERT INTO inbox_activities (activity_id, kind, payload_json, created_at, state) VALUES (?, 'Create', '{}', ?, ?)",
      ).bind(id, createdAt, state);
    const base = "https://remote.example/activities/vacuum";
    await env.DB.batch([
      insert(`${base}/old`, OLD),
      insert(`${base}/12-days`, at(12)),
      insert(`${base}/4-days`, at(4)),
      insert(`${base}/old-claim`, OLD, "Processing"),
    ]);
    // A day is asked for; the dedupe floor of 7 days applies.
    const pass = await vacuumActivities(withVars({ INBOX_ACTIVITY_RETENTION_DAYS: "1" }), NOW);
    expect(pass._unsafeUnwrap().inbox).toBe(2);
    const state = async (id: string) => (await inboxActivityState(env.DB, id))._unsafeUnwrap();
    expect(await state(`${base}/old`)).toBeUndefined();
    expect(await state(`${base}/12-days`)).toBeUndefined();
    // The inbox answers a redelivery of this one as a duplicate.
    expect(await state(`${base}/4-days`)).toBe("Processed");
    // A claim is the stale-claim release's to delete, never the vacuum's.
    expect(await state(`${base}/old-claim`)).toBe("Processing");
  });

  it("leaves a table alone when its retention is off", async () => {
    await env.DB.batch([
      insertDelivery("vf-delivered-old", "vacuum-off", "Delivered", "https://a.example/inbox", OLD),
      env.DB.prepare(
        "INSERT INTO inbox_activities (activity_id, kind, payload_json, created_at) VALUES (?, 'Create', '{}', ?)",
      ).bind("https://remote.example/activities/vacuum-off", OLD),
    ]);
    const off = withVars({
      OUTBOX_DELIVERY_RETENTION_DAYS: "off",
      OUTBOUND_ACTIVITY_RETENTION_DAYS: "0",
      INBOX_ACTIVITY_RETENTION_DAYS: "off",
    });
    const pass = await vacuumActivities(off, NOW);
    expect(pass._unsafeUnwrap()).toEqual({ deliveries: 0, outbound: 0, inbox: 0, chained: false });
    expect(
      await ids("SELECT id FROM outbox_deliveries WHERE id = 'vf-delivered-old'"),
    ).toHaveLength(1);
  });

  it("reads only the rows it may delete, through the retention indexes", async () => {
    const plan = async (sql: string): Promise<string> => {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
      return z
        .array(z.object({ detail: z.string() }))
        .parse(results)
        .map((row) => row.detail)
        .join("\n");
    };
    expect(
      await plan(
        `SELECT id FROM outbox_deliveries WHERE kind IN ('Delivered', 'Failed', 'Expanded', 'Skipped') AND updated_at < '2001' ORDER BY updated_at LIMIT 500`,
      ),
    ).toContain("idx_outbox_deliveries_finished");
    expect(
      await plan(
        "SELECT id FROM outbound_activities WHERE created_at < '2001' ORDER BY created_at LIMIT 500",
      ),
    ).toContain("idx_outbound_activities_created");
    expect(
      await plan(
        "SELECT activity_id FROM inbox_activities WHERE created_at < '2001' ORDER BY created_at LIMIT 500",
      ),
    ).toContain("idx_inbox_activities_created");
  });

  it("is queued by the six-hourly cron, not the hourly one", async () => {
    const send = vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "send").mockResolvedValue(QUEUED);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    const fire = async (cron: string) => {
      const ctx = createExecutionContext();
      await handleScheduled(
        { cron, scheduledTime: Date.now(), noRetry: () => undefined },
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
    };
    await fire("17 * * * *");
    expect(send).not.toHaveBeenCalledWith({ kind: "VacuumActivities" });
    await fire("17 */6 * * *");
    expect(send).toHaveBeenCalledWith({ kind: "VacuumActivities" });
  });

  // Runs at today's date, so it comes last: it prunes every 2001 row above.
  it("chains another pass after a full batch and stops once the backlog is gone", async () => {
    const activity = "vacuum-chain";
    const total = ActivityVacuum.batch + 100;
    await env.DB.batch(
      Array.from({ length: total }, (_, n) =>
        insertDelivery(`vc-${n}`, activity, "Delivered", `https://h${n}.example/inbox`, OLD),
      ),
    );
    const count = async () =>
      (await ids("SELECT id FROM outbox_deliveries WHERE activity_id = ?", activity)).length;
    const send = vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "send").mockResolvedValue(QUEUED);
    const log = vi.spyOn(console, "log");

    expect(await processOutboxJob(env, { kind: "VacuumActivities" })).toBe("ok");
    expect(send).toHaveBeenCalledWith({ kind: "VacuumActivities" });
    // Earlier tests in this file may leave a 2001 row or two in the same batch.
    expect(await count()).toBeLessThan(total);
    expect(await count()).toBeGreaterThanOrEqual(total - ActivityVacuum.batch);
    const events = log.mock.calls
      .map((call) => call[0])
      .filter(
        (line): line is string => typeof line === "string" && line.includes("ActivityVacuumPass"),
      )
      .map((line) =>
        z.object({ deliveries: z.number(), chained: z.boolean() }).parse(JSON.parse(line)),
      );
    expect(events).toEqual([{ deliveries: ActivityVacuum.batch, chained: true }]);

    send.mockClear();
    expect(await processOutboxJob(env, { kind: "VacuumActivities" })).toBe("ok");
    expect(await count()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
