import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "cloudflare:test";

/**
 * Meters what Worker code costs on Cloudflare's billed meters, from inside
 * the test isolate: D1 statements, serial rounds, rows read and written
 * (each statement's `meta`), Durable Object requests, Queue messages, KV
 * reads and writes, and Workflow instances. `patchD1` / `patchBindings`
 * patch the bindings' prototypes once; read `meter.tally`, clear it with
 * `resetMeter`. Used by the query-count report and the D1 budget test.
 *
 * A call counts toward the tally that was current when the `SELF` request
 * making it started (`patchD1` wraps the Worker's `fetch`), or when
 * `meterWork` started the work that makes it. The isolate also runs work no
 * test is measuring: a Workflow retrying a delivery an earlier test queued, a
 * queue batch. That work is not counted, and a request's own after-response
 * work never lands in a later request's tally. `requestsSettled` waits for
 * that after-response work (what the requests handed `ctx.waitUntil`), so a
 * tally read after it holds all of it.
 */

export type Tally = {
  statements: number;
  rounds: number;
  batches: number;
  sql: string[];
  /** D1 billing: `meta.rows_read` / `meta.rows_written` of every statement. */
  rowsRead: number;
  rowsWritten: number;
  /** Durable Object requests (each stub call or RPC session is one billed request). */
  doRequests: number;
  /** Queue messages sent (each costs a write, a read and a delete operation). */
  queueMessages: number;
  kvReads: number;
  kvWrites: number;
  workflowCreates: number;
  /** `rows_read rows_written sql` per statement, for `QUERY_COUNT_SQL`. */
  rowsBySql: string[];
};

const emptyTally = (): Tally => ({
  statements: 0,
  rounds: 0,
  batches: 0,
  sql: [],
  rowsRead: 0,
  rowsWritten: 0,
  doRequests: 0,
  queueMessages: 0,
  kvReads: 0,
  kvWrites: 0,
  workflowCreates: 0,
  rowsBySql: [],
});

/** What the patched bindings counted since the last `resetMeter`. */
export const meter: { tally: Tally } = { tally: emptyTally() };
const counting = new AsyncLocalStorage<Tally>();
const inFlight = new WeakMap<Tally, number>();
/** What the requests counted toward a tally handed `ctx.waitUntil`. */
const keptAlive = new WeakMap<Tally, Promise<unknown>[]>();

/**
 * Wait until the work the requests counted toward `meter.tally` kept alive
 * past their responses has settled, including work that work kept alive.
 */
export const requestsSettled = async (): Promise<void> => {
  const pending = keptAlive.get(meter.tally) ?? [];
  while (pending.length > 0) {
    await Promise.allSettled(pending.splice(0));
  }
};

/** `ctx` with its `waitUntil` also recording each promise against `tally`. */
const keepingAlive = (ctx: unknown, tally: Tally): void => {
  if (typeof ctx !== "object" || ctx === null) {
    return;
  }
  const waitUntil: unknown = Reflect.get(ctx, "waitUntil");
  if (typeof waitUntil !== "function") {
    return;
  }
  Reflect.set(ctx, "waitUntil", (promise: Promise<unknown>) => {
    const pending = keptAlive.get(tally) ?? [];
    keptAlive.set(tally, pending);
    pending.push(promise);
    return Reflect.apply(waitUntil, ctx, [promise]);
  });
};

/** Run `work`, made in the test itself rather than through `SELF`, counted toward `meter.tally`. */
export const meterWork = <T>(work: () => Promise<T>): Promise<T> => counting.run(meter.tally, work);

/**
 * The Worker `SELF` requests: the module `@cloudflare/vitest-plugin` imports
 * as `main` (the root Vitest config's `dist/ssr/wrangler.json`), whose
 * `fetch` it looks up on every request.
 */
const mainModule = "../dist/ssr/index.js";
const worker: unknown = Reflect.get(await import(/* @vite-ignore */ mainModule), "default");

const sqlOf = (statement: unknown): string => {
  const text =
    typeof statement === "object" && statement !== null
      ? Reflect.get(statement, "statement")
      : undefined;
  return typeof text === "string" ? text.replace(/\s+/g, " ").slice(0, 140) : "?";
};

const countMeta = (tally: Tally, result: unknown, sql = "?"): void => {
  const meta =
    typeof result === "object" && result !== null ? Reflect.get(result, "meta") : undefined;
  if (typeof meta !== "object" || meta === null) {
    return;
  }
  const read = Reflect.get(meta, "rows_read");
  const written = Reflect.get(meta, "rows_written");
  tally.rowsRead += typeof read === "number" ? read : 0;
  tally.rowsWritten += typeof written === "number" ? written : 0;
  tally.rowsBySql.push(`${String(read)} ${String(written)} ${sql}`);
};

const track = async <T>(
  statements: number,
  work: (tally: Tally | undefined) => Promise<T>,
  sql: ReadonlyArray<string> = [],
): Promise<T> => {
  const tally = counting.getStore();
  if (tally === undefined) {
    return work(undefined);
  }
  const running = inFlight.get(tally) ?? 0;
  tally.sql.push(...sql.map((text) => `${running === 0 ? "+" : " "} ${text}`));
  if (running === 0) {
    tally.rounds += 1;
  }
  inFlight.set(tally, running + 1);
  tally.statements += statements;
  try {
    return await work(tally);
  } finally {
    inFlight.set(tally, (inFlight.get(tally) ?? 0) - 1);
  }
};

/** Bump a binding counter of the tally the calling work counts toward, if any. */
const bump = (
  key: "doRequests" | "queueMessages" | "kvReads" | "kvWrites" | "workflowCreates",
  by = 1,
) => {
  const tally = counting.getStore();
  if (tally !== undefined) {
    tally[key] += by;
  }
};

const patchMethod = (
  proto: object,
  method: string,
  wrap: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
): void => {
  const original = Reflect.get(proto, method);
  if (typeof original === "function") {
    Reflect.set(proto, method, wrap(original));
  }
};

export const patchD1 = (): void => {
  const dbProto: object = Object.getPrototypeOf(env.DB);
  const stmtProto: object = Object.getPrototypeOf(env.DB.prepare("SELECT 1"));
  const marker = "__queryCountPatched";
  if (Reflect.get(dbProto, marker)) {
    return;
  }
  Reflect.set(dbProto, marker, true);
  if (
    typeof worker !== "object" ||
    worker === null ||
    typeof Reflect.get(worker, "fetch") !== "function"
  ) {
    throw new Error(`${mainModule} exports no default fetch handler to meter`);
  }
  patchMethod(
    worker,
    "fetch",
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        const tally = meter.tally;
        keepingAlive(args[2], tally);
        return counting.run(tally, () => Reflect.apply(original, this, args));
      },
  );
  const all = Reflect.get(stmtProto, "all");
  for (const method of ["run", "all"]) {
    patchMethod(
      stmtProto,
      method,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          return track(
            1,
            async (tally) => {
              const result: unknown = await Reflect.apply(original, this, args);
              if (tally) countMeta(tally, result);
              return result;
            },
            [sqlOf(this)],
          );
        },
    );
  }
  // `first` hides `meta`; read through `all` so the rows it reads are counted.
  patchMethod(
    stmtProto,
    "first",
    () =>
      function (this: unknown, column?: unknown) {
        return track(
          1,
          async (tally) => {
            const result: unknown = await Reflect.apply(all, this, []);
            if (tally) countMeta(tally, result);
            const rows =
              typeof result === "object" && result !== null ? Reflect.get(result, "results") : [];
            const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
            if (row === undefined) {
              return null;
            }
            return typeof column === "string" && typeof row === "object" && row !== null
              ? Reflect.get(row, column)
              : row;
          },
          [sqlOf(this)],
        );
      },
  );
  patchMethod(
    dbProto,
    "batch",
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        const statements = Array.isArray(args[0]) ? args[0] : [];
        return track(
          statements.length,
          async (tally) => {
            if (tally) tally.batches += 1;
            const results: unknown = await Reflect.apply(original, this, [statements]);
            if (tally && Array.isArray(results)) {
              results.forEach((result: unknown, index) => {
                countMeta(tally, result, `[batch] ${sqlOf(statements[index])}`);
              });
            }
            return results;
          },
          statements.map((statement) => `[batch] ${sqlOf(statement)}`),
        );
      },
  );
};

/** Count Durable Object, Queue, KV and Workflow calls on the bindings' prototypes. */
export const patchBindings = (): void => {
  const bindings: object = env;
  for (const name of ["STREAM_HUB", "RATE_LIMIT_COUNTER"]) {
    const namespace: unknown = Reflect.get(bindings, name);
    if (typeof namespace !== "object" || namespace === null) continue;
    const proto: object = Object.getPrototypeOf(namespace);
    if (Reflect.get(proto, "__queryCountPatched")) continue;
    Reflect.set(proto, "__queryCountPatched", true);
    for (const method of ["get", "getByName"]) {
      patchMethod(
        proto,
        method,
        (original) =>
          function (this: unknown, ...args: unknown[]) {
            const stub: unknown = Reflect.apply(original, this, args);
            if (typeof stub !== "object" || stub === null) return stub;
            return new Proxy(stub, {
              get(target, key) {
                const value: unknown = Reflect.get(target, key);
                if (typeof value !== "function" || key === "then" || typeof key === "symbol") {
                  return value;
                }
                return (...callArgs: unknown[]) => {
                  bump("doRequests");
                  return Reflect.apply(value, target, callArgs);
                };
              },
            });
          },
      );
    }
  }
  const queue: unknown = Reflect.get(bindings, "OUTBOX_PROCESS_QUEUE");
  if (typeof queue === "object" && queue !== null) {
    const proto: object = Object.getPrototypeOf(queue);
    if (!Reflect.get(proto, "__queryCountPatched")) {
      Reflect.set(proto, "__queryCountPatched", true);
      patchMethod(
        proto,
        "send",
        (original) =>
          function (this: unknown, ...args: unknown[]) {
            bump("queueMessages");
            return Reflect.apply(original, this, args);
          },
      );
      patchMethod(
        proto,
        "sendBatch",
        (original) =>
          function (this: unknown, messages: unknown, ...rest: unknown[]) {
            bump("queueMessages", Array.isArray(messages) ? messages.length : 1);
            return Reflect.apply(original, this, [messages, ...rest]);
          },
      );
    }
  }
  const workflow: unknown = Reflect.get(bindings, "OUTBOX_DELIVERY_WORKFLOW");
  if (typeof workflow === "object" && workflow !== null) {
    const proto: object = Object.getPrototypeOf(workflow);
    if (!Reflect.get(proto, "__queryCountPatched")) {
      Reflect.set(proto, "__queryCountPatched", true);
      patchMethod(
        proto,
        "create",
        (original) =>
          function (this: unknown, ...args: unknown[]) {
            bump("workflowCreates");
            return Reflect.apply(original, this, args);
          },
      );
      patchMethod(
        proto,
        "createBatch",
        (original) =>
          function (this: unknown, batch: unknown, ...rest: unknown[]) {
            bump("workflowCreates", Array.isArray(batch) ? batch.length : 1);
            return Reflect.apply(original, this, [batch, ...rest]);
          },
      );
    }
  }
  for (const value of Object.values(env)) {
    if (typeof value !== "object" || value === null) continue;
    const proto: object = Object.getPrototypeOf(value);
    if (proto?.constructor?.name !== "KvNamespace" || Reflect.get(proto, "__queryCountPatched"))
      continue;
    Reflect.set(proto, "__queryCountPatched", true);
    for (const method of ["get", "getWithMetadata", "list"]) {
      patchMethod(
        proto,
        method,
        (original) =>
          function (this: unknown, ...args: unknown[]) {
            bump("kvReads");
            return Reflect.apply(original, this, args);
          },
      );
    }
    for (const method of ["put", "delete"]) {
      patchMethod(
        proto,
        method,
        (original) =>
          function (this: unknown, ...args: unknown[]) {
            bump("kvWrites");
            return Reflect.apply(original, this, args);
          },
      );
    }
  }
};

/**
 * `QUERY_COUNT_NOISE=<n>` adds n statuses by an account nobody in the
 * scenario follows (with a favourite each, a notification for another
 * account per ten) and n remote statuses by an unfollowed actor, all older
 * than the scenario. A request whose rows read grows with n reads rows it
 * does not show.
 */
export const seedNoise = async (noiseAccountId: string, favouriterId: string, n: number) => {
  const series = `WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < ${n})`;
  await env.DB.batch([
    env.DB.prepare(
      `${series} INSERT INTO statuses (id, account_id, kind, content_text, content_html, visibility, sensitive, spoiler_text, created_at, updated_at)
       SELECT printf('noise%07d', n), ?, 'LocalNote', 'noise', '<p>noise</p>', 'public', 0, '',
              strftime('%Y-%m-%dT%H:%M:%fZ', '2020-01-01', '+' || n || ' seconds'),
              strftime('%Y-%m-%dT%H:%M:%fZ', '2020-01-01', '+' || n || ' seconds')
       FROM series`,
    ).bind(noiseAccountId),
    env.DB.prepare(
      `${series} INSERT INTO favourites (id, account_id, local_status_id, created_at)
       SELECT printf('noisefav%07d', n), ?, printf('noise%07d', n), '2020-01-02T00:00:00.000Z' FROM series`,
    ).bind(favouriterId),
    env.DB.prepare(
      `${series} INSERT INTO notifications (id, account_id, from_account_id, kind, status_id, created_at)
       SELECT printf('noisenotif%07d', n), ?, ?, 'favourite', printf('noise%07d', n), '2020-01-02T00:00:00.000Z'
       FROM series WHERE n % 10 = 0`,
    ).bind(noiseAccountId, favouriterId),
    env.DB.prepare(
      `INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, public_key_id, public_key_pem, fetched_at)
       VALUES ('https://noise.example/users/n', 'n', 'noise.example', 'https://noise.example/inbox',
               'https://noise.example/users/n#main-key', 'x', '2020-01-01T00:00:00.000Z')`,
    ),
    env.DB.prepare(
      `${series} INSERT INTO remote_statuses (id, actor_uri, object_uri, content_html, visibility, published_at, created_at, updated_at, media_json, tags_indexed, emojis_json)
       SELECT printf('rnoise%07d', n), 'https://noise.example/users/n', printf('https://noise.example/statuses/%d', n),
              '<p>noise</p>', 'public', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '[]', 1, '[]'
       FROM series`,
    ),
  ]);
};

export const resetMeter = (): void => {
  meter.tally = emptyTally();
};

export const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
