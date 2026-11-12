import { env } from "cloudflare:test";

/**
 * Meters what Worker code costs on Cloudflare's billed meters, from inside
 * the test isolate: D1 statements, serial rounds, rows read and written
 * (each statement's `meta`), Durable Object requests, Queue messages, KV
 * reads and writes, and Workflow instances. `patchD1` / `patchBindings`
 * patch the bindings' prototypes once; read `meter.tally`, clear it with
 * `resetMeter`. Used by the query-count report and the D1 budget test.
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
let inFlight = 0;

const sqlOf = (statement: unknown): string => {
  const text =
    typeof statement === "object" && statement !== null
      ? Reflect.get(statement, "statement")
      : undefined;
  return typeof text === "string" ? text.replace(/\s+/g, " ").slice(0, 140) : "?";
};

const countMeta = (result: unknown, sql = "?"): void => {
  const meta =
    typeof result === "object" && result !== null ? Reflect.get(result, "meta") : undefined;
  if (typeof meta !== "object" || meta === null) {
    return;
  }
  const read = Reflect.get(meta, "rows_read");
  const written = Reflect.get(meta, "rows_written");
  meter.tally.rowsRead += typeof read === "number" ? read : 0;
  meter.tally.rowsWritten += typeof written === "number" ? written : 0;
  meter.tally.rowsBySql.push(`${String(read)} ${String(written)} ${sql}`);
};

const track = async <T>(
  statements: number,
  work: () => Promise<T>,
  sql: ReadonlyArray<string> = [],
): Promise<T> => {
  meter.tally.sql.push(...sql.map((text) => `${inFlight === 0 ? "+" : " "} ${text}`));
  if (inFlight === 0) {
    meter.tally.rounds += 1;
  }
  inFlight += 1;
  meter.tally.statements += statements;
  try {
    return await work();
  } finally {
    inFlight -= 1;
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
  const all = Reflect.get(stmtProto, "all");
  for (const method of ["run", "all"]) {
    patchMethod(
      stmtProto,
      method,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          return track(
            1,
            async () => {
              const result: unknown = await Reflect.apply(original, this, args);
              countMeta(result);
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
          async () => {
            const result: unknown = await Reflect.apply(all, this, []);
            countMeta(result);
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
        meter.tally.batches += 1;
        return track(
          statements.length,
          async () => {
            const results: unknown = await Reflect.apply(original, this, [statements]);
            if (Array.isArray(results)) {
              results.forEach((result: unknown, index) => {
                countMeta(result, `[batch] ${sqlOf(statements[index])}`);
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
                  meter.tally.doRequests += 1;
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
            meter.tally.queueMessages += 1;
            return Reflect.apply(original, this, args);
          },
      );
      patchMethod(
        proto,
        "sendBatch",
        (original) =>
          function (this: unknown, messages: unknown, ...rest: unknown[]) {
            meter.tally.queueMessages += Array.isArray(messages) ? messages.length : 1;
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
            meter.tally.workflowCreates += 1;
            return Reflect.apply(original, this, args);
          },
      );
      patchMethod(
        proto,
        "createBatch",
        (original) =>
          function (this: unknown, batch: unknown, ...rest: unknown[]) {
            meter.tally.workflowCreates += Array.isArray(batch) ? batch.length : 1;
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
            meter.tally.kvReads += 1;
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
            meter.tally.kvWrites += 1;
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
