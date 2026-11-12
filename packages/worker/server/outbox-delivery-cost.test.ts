import { env } from "cloudflare:test";
import type {
  WorkflowEvent,
  WorkflowSleepDuration,
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowStepConfigWithDelayFunction,
  WorkflowStepConfigWithStaticDelay,
  WorkflowStepContext,
  WorkflowStepEvent,
  WorkflowStepRollbackOptions,
  WorkflowDelayDuration,
  WorkflowDelayFunction,
} from "cloudflare:workers";
import { OutboxJob } from "@tstodon/domain";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { signedInAccount } from "../test/auth-fixture";
import { forgetDeliveryDomainHealthCache } from "./delivery-domain-health-store";
import { OutboxDeliveryWorkflow, type OutboxWorkflowParams } from "./outbox-delivery-workflow";
import { processOutboxJob } from "./outbox-job";
import { insertOutboundActivity } from "./outbox-store";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

type Meter = { statements: number; rowsRead: number; rowsWritten: number };

const newMeter = (): Meter => ({ statements: 0, rowsRead: 0, rowsWritten: 0 });

const addMeta = (meter: Meter, result: unknown): void => {
  const meta: unknown =
    typeof result === "object" && result !== null ? Reflect.get(result, "meta") : undefined;
  if (typeof meta !== "object" || meta === null) {
    return;
  }
  const read: unknown = Reflect.get(meta, "rows_read");
  const written: unknown = Reflect.get(meta, "rows_written");
  meter.statements += 1;
  meter.rowsRead += typeof read === "number" ? read : 0;
  meter.rowsWritten += typeof written === "number" ? written : 0;
};

/** `db`, with the billed rows of every statement added to `meter.current`. */
const meteredDb = (db: D1Database, meter: { current: Meter }): D1Database => {
  const unwrapped = new WeakMap<object, D1PreparedStatement>();
  const statement = (inner: D1PreparedStatement): D1PreparedStatement => {
    const outer = new Proxy(inner, {
      get(target, key) {
        switch (key) {
          case "bind":
            return (...values: unknown[]) => statement(target.bind(...values));
          case "all":
          case "run":
            return async () => {
              const result = await target.all();
              addMeta(meter.current, result);
              return result;
            };
          case "first":
            return async (column?: string) => {
              const result = await target.all();
              addMeta(meter.current, result);
              const row: unknown = result.results[0];
              if (row === undefined || row === null) {
                return null;
              }
              return typeof column === "string" && typeof row === "object"
                ? Reflect.get(row, column)
                : row;
            };
          default: {
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          }
        }
      },
    });
    unwrapped.set(outer, inner);
    return outer;
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => statement(target.prepare(sql));
      }
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(
            statements.map((outer) => unwrapped.get(outer) ?? outer),
          );
          for (const result of results) {
            addMeta(meter.current, result);
          }
          return results;
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

/** A `WorkflowStep` that runs each step at once and counts `do` and `sleep` calls. */
class CountingStep implements WorkflowStep {
  dos = 0;
  sleeps = 0;
  readonly names: string[] = [];

  do<T extends Rpc.Serializable<T>>(
    name: string,
    callback: (ctx: WorkflowStepContext) => Promise<T>,
    rollbackOptions?: WorkflowStepRollbackOptions<T>,
  ): Promise<T>;
  do<T extends Rpc.Serializable<T>>(
    name: string,
    config: WorkflowStepConfigWithDelayFunction,
    callback: (ctx: WorkflowStepContext<WorkflowDelayFunction>) => Promise<T>,
    rollbackOptions?: WorkflowStepRollbackOptions<T, WorkflowDelayFunction>,
  ): Promise<T>;
  do<T extends Rpc.Serializable<T>>(
    name: string,
    config: WorkflowStepConfigWithStaticDelay,
    callback: (ctx: WorkflowStepContext<WorkflowDelayDuration | number>) => Promise<T>,
    rollbackOptions?: WorkflowStepRollbackOptions<T, WorkflowDelayDuration | number>,
  ): Promise<T>;
  do<T extends Rpc.Serializable<T>>(
    name: string,
    config: WorkflowStepConfig,
    callback: (ctx: WorkflowStepContext) => Promise<T>,
    rollbackOptions?: WorkflowStepRollbackOptions<T>,
  ): Promise<T>;
  async do(name: string, first: unknown, second?: unknown): Promise<unknown> {
    const callback = typeof first === "function" ? first : second;
    if (typeof callback !== "function") {
      throw new Error(`step ${name} has no callback`);
    }
    this.dos += 1;
    this.names.push(name);
    const ctx: WorkflowStepContext = { step: { name, count: 1 }, attempt: 1, config: {} };
    const result: unknown = await callback(ctx);
    return result;
  }

  sleep = async (name: string, _duration: WorkflowSleepDuration): Promise<void> => {
    this.sleeps += 1;
    this.names.push(name);
  };

  sleepUntil = async (name: string, _timestamp: Date | number): Promise<void> => {
    this.sleeps += 1;
    this.names.push(name);
  };

  waitForEvent<T extends Rpc.Serializable<T>>(name: string): Promise<WorkflowStepEvent<T>> {
    throw new Error(`unexpected waitForEvent ${name}`);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  forgetDeliveryDomainHealthCache();
});

describe("outbox delivery cost", () => {
  it("delivers one activity to 25 inboxes, 2 failing once, within a bounded number of Workflow steps", async () => {
    const account = await signedInAccount("delivery-cost@example.com");
    const hosts = Array.from(
      { length: 25 },
      (_, i) => `cost-${String(i).padStart(2, "0")}.example`,
    );
    const failing = new Set([hosts[3], hosts[17]]);
    await env.DB.batch(
      hosts.flatMap((host) => {
        const actor = `https://${host}/users/u`;
        return [
          env.DB.prepare(
            `INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, public_key_id, public_key_pem, fetched_at)
             VALUES (?, 'u', ?, ?, ?, 'pem', '2026-11-01T00:00:00Z')`,
          ).bind(actor, host, `https://${host}/inbox`, `${actor}#main-key`),
          env.DB.prepare(
            `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind)
             VALUES (?, ?, ?, 'Fulfilled', 'Accepted')`,
          ).bind(crypto.randomUUID(), actor, account.id),
        ];
      }),
    );
    const inserted = await insertOutboundActivity(env.DB, {
      signer: { kind: "Account", accountId: account.id },
      kind: "Create",
      payload: {
        type: "Create",
        id: `https://example.com/users/x/statuses/${crypto.randomUUID()}/activity`,
        to: [PUBLIC],
        cc: [],
        object: { type: "Note", to: [PUBLIC], cc: [] },
      },
    });
    const activityId = inserted._unsafeUnwrap().id;

    const meter = { current: newMeter() };
    const created: OutboxWorkflowParams[] = [];
    const workflows = new Proxy(env.OUTBOX_DELIVERY_WORKFLOW, {
      get(target, key) {
        if (key === "create") {
          return async (options: { id: string; params: OutboxWorkflowParams }) => {
            created.push(options.params);
            return { id: options.id };
          };
        }
        if (key === "createBatch") {
          return async (batch: ReadonlyArray<{ id: string; params: OutboxWorkflowParams }>) => {
            created.push(...batch.map((options) => options.params));
            return batch.map((options) => ({ id: options.id }));
          };
        }
        return Reflect.get(target, key);
      },
    });
    const db = meteredDb(env.DB, meter);
    const costEnv = new Proxy(env, {
      get(target, key) {
        if (key === "DB") return db;
        if (key === "OUTBOX_DELIVERY_WORKFLOW") return workflows;
        return Reflect.get(target, key);
      },
    });

    const posted = new Map<string, number>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const host = new URL(request.url).host;
      const count = (posted.get(host) ?? 0) + 1;
      posted.set(host, count);
      return new Response(null, { status: failing.has(host) && count === 1 ? 503 : 202 });
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const expandJob = OutboxJob.parse({ kind: "ExpandFollowers", activityId });
    if (expandJob.isErr()) {
      throw new Error("expand job rejected");
    }
    await processOutboxJob(costEnv, expandJob.value);
    const expand = meter.current;

    meter.current = newMeter();
    const step = new CountingStep();
    for (const [index, params] of created.entries()) {
      const event: WorkflowEvent<OutboxWorkflowParams> = {
        payload: params,
        timestamp: new Date(),
        instanceId: `cost-${index}`,
        workflowName: "outbox-delivery",
      };
      // The runtime constructs a WorkflowEntrypoint only for a real instance;
      // `run` reads nothing but `this.env`.
      await Reflect.apply(Reflect.get(OutboxDeliveryWorkflow.prototype, "run"), { env: costEnv }, [
        event,
        step,
      ]);
    }
    const delivery = meter.current;

    const { results } = await env.DB.prepare(
      "SELECT kind, COUNT(*) AS n FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NOT NULL GROUP BY kind",
    )
      .bind(activityId)
      .all();
    expect(results).toEqual([{ kind: "Delivered", n: 25 }]);
    expect([...posted.values()].reduce((sum, n) => sum + n, 0)).toBe(27);

    console.info(
      `DELIVERY_COST inboxes=25 failing=2 creates=${created.length} step_do=${step.dos} step_sleep=${step.sleeps}` +
        ` expand_statements=${expand.statements} expand_rows_read=${expand.rowsRead} expand_rows_written=${expand.rowsWritten}` +
        ` delivery_statements=${delivery.statements} delivery_rows_read=${delivery.rowsRead} delivery_rows_written=${delivery.rowsWritten}`,
    );
  });
});
