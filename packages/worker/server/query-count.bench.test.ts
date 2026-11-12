import { env, SELF } from "cloudflare:test";
import { describe, it } from "vite-plus/test";
import { accessTokenFor, signedInAccount } from "../test/auth-fixture";

/**
 * Counts the D1 statements and serial D1 rounds each Mastodon API request
 * costs on one seeded scenario. Not an assertion suite: it prints a table
 * (`QUERY_COUNT_ROW` lines) for comparing implementations and branches.
 * Run with `pnpm build && QUERY_COUNT=1 pnpm vp test run --project worker query-count
 * --silent=false`; without `QUERY_COUNT=1` it is skipped.
 */

type Tally = {
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

let tally: Tally = emptyTally();
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
  tally.rowsRead += typeof read === "number" ? read : 0;
  tally.rowsWritten += typeof written === "number" ? written : 0;
  tally.rowsBySql.push(`${String(read)} ${String(written)} ${sql}`);
};

const track = async <T>(
  statements: number,
  work: () => Promise<T>,
  sql: ReadonlyArray<string> = [],
): Promise<T> => {
  tally.sql.push(...sql.map((text) => `${inFlight === 0 ? "+" : " "} ${text}`));
  if (inFlight === 0) {
    tally.rounds += 1;
  }
  inFlight += 1;
  tally.statements += statements;
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

const patchD1 = (): void => {
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
        tally.batches += 1;
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
const patchBindings = (): void => {
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
                  tally.doRequests += 1;
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
            tally.queueMessages += 1;
            return Reflect.apply(original, this, args);
          },
      );
      patchMethod(
        proto,
        "sendBatch",
        (original) =>
          function (this: unknown, messages: unknown, ...rest: unknown[]) {
            tally.queueMessages += Array.isArray(messages) ? messages.length : 1;
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
            tally.workflowCreates += 1;
            return Reflect.apply(original, this, args);
          },
      );
      patchMethod(
        proto,
        "createBatch",
        (original) =>
          function (this: unknown, batch: unknown, ...rest: unknown[]) {
            tally.workflowCreates += Array.isArray(batch) ? batch.length : 1;
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
            tally.kvReads += 1;
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
            tally.kvWrites += 1;
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
const seedNoise = async (noiseAccountId: string, favouriterId: string, n: number) => {
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

const reset = (): void => {
  tally = emptyTally();
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

type Json = Record<string, unknown>;

const call = async (
  token: string,
  method: string,
  path: string,
  body?: Json,
): Promise<{ status: number; json: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "CF-Connecting-IP": "203.0.113.7",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
};

const idOf = (value: unknown): string => {
  const id = typeof value === "object" && value !== null ? Reflect.get(value, "id") : undefined;
  if (typeof id !== "string") {
    throw new Error(`no id in ${JSON.stringify(value).slice(0, 200)}`);
  }
  return id;
};

/**
 * The response body with entity ids numbered by first appearance and
 * timestamps blanked, so two runs (or two branches) print the same line
 * exactly when they return the same body.
 */
const normalizedBody = (value: unknown): string => {
  const ids = new Map<string, string>();
  return JSON.stringify(value)
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>")
    .replace(/(?<!\d)\d{18}(?!\d)/g, (id) => {
      const known = ids.get(id) ?? `<id${ids.size + 1}>`;
      ids.set(id, known);
      return known;
    });
};

const measure = async (
  label: string,
  token: string,
  method: string,
  path: string,
  body?: Json,
): Promise<unknown> => {
  await settle();
  reset();
  const result = await call(token, method, path, body);
  const before = { ...tally, sql: [...tally.sql] };
  await settle();
  const deferred = tally.statements - before.statements;
  const size = Array.isArray(result.json) ? result.json.length : "";
  // Rows and binding calls are totals, deferred work included: all of it is billed.
  console.log(
    `QUERY_COUNT_ROW|${label}|${result.status}|${size}|${before.statements}|${before.rounds}|${before.batches}|${deferred}|${tally.rowsRead}|${tally.rowsWritten}|${tally.doRequests}|${tally.queueMessages}|${tally.kvReads}|${tally.kvWrites}|${tally.workflowCreates}`,
  );
  console.log(`QUERY_SHAPE|${label}|${normalizedBody(result.json)}`);
  const detail = Reflect.get(env, "QUERY_COUNT_SQL");
  if (typeof detail === "string" && detail !== "" && label.includes(detail)) {
    console.log(before.sql.map((line) => `QUERY_SQL ${line}`).join("\n"));
    console.log(
      tally.rowsBySql
        .toSorted((left, right) => Number(right.split(" ")[0]) - Number(left.split(" ")[0]))
        .slice(0, 8)
        .map((line) => `QUERY_ROWS ${line}`)
        .join("\n"),
    );
    console.log(
      tally.sql
        .slice(before.sql.length)
        .map((line) => `QUERY_SQL_DEFERRED ${line}`)
        .join("\n"),
    );
  }
  return result.json;
};

describe.runIf(Reflect.get(env, "QUERY_COUNT") === "1")("D1 query counts", () => {
  it("prints statements and rounds per request", { timeout: 300_000 }, async () => {
    const names = ["qc-alice", "qc-bob", "qc-carol", ...[1, 2, 3, 4, 5, 6].map((n) => `qc-f${n}`)];
    const accounts = await Promise.all(names.map((name) => signedInAccount(`${name}@example.com`)));
    const [alice, bob, carol, ...followers] = accounts;
    if (!alice || !bob || !carol) throw new Error("accounts");
    const tokens = await Promise.all(accounts.map((account) => accessTokenFor(account.id)));
    const [ta, tb, tc, ...tf] = tokens;
    if (!ta || !tb || !tc) throw new Error("tokens");

    await call(ta, "POST", `/api/v1/accounts/${bob.id}/follow`);
    await call(ta, "POST", `/api/v1/accounts/${carol.id}/follow`);
    for (const token of tf) {
      await call(token, "POST", `/api/v1/accounts/${alice.id}/follow`);
    }
    const bobStatuses: string[] = [];
    for (let n = 0; n < 15; n += 1) {
      const text = n % 3 === 0 ? `post ${n} #qctag @${alice.username}` : `post ${n}`;
      bobStatuses.push(idOf((await call(tb, "POST", "/api/v1/statuses", { status: text })).json));
    }
    for (const id of bobStatuses.slice(0, 3)) {
      await call(tc, "POST", `/api/v1/statuses/${id}/reblog`);
    }
    for (const id of bobStatuses.slice(0, 5)) {
      await call(tc, "POST", `/api/v1/statuses/${id}/favourite`);
      await call(ta, "POST", `/api/v1/statuses/${id}/favourite`);
      await call(ta, "POST", `/api/v1/statuses/${id}/bookmark`);
    }
    const root = idOf((await call(ta, "POST", "/api/v1/statuses", { status: "thread root" })).json);
    await call(tb, "POST", `/api/v1/statuses/${root}/favourite`);
    const replyIds: string[] = [];
    let parent = root;
    for (let n = 0; n < 10; n += 1) {
      const token = n % 2 === 0 ? tb : tc;
      parent = idOf(
        (
          await call(token, "POST", "/api/v1/statuses", {
            status: `reply ${n}`,
            in_reply_to_id: parent,
          })
        ).json,
      );
      replyIds.push(parent);
    }
    for (let n = 0; n < 3; n += 1) {
      await call(tb, "POST", "/api/v1/statuses", {
        status: `@${alice.username} dm ${n}`,
        visibility: "direct",
      });
    }
    const list = idOf((await call(ta, "POST", "/api/v1/lists", { title: "qc" })).json);
    await call(ta, "POST", `/api/v1/lists/${list}/accounts`, { account_ids: [bob.id, carol.id] });

    const noise = Number(Reflect.get(env, "QUERY_COUNT_NOISE") ?? "0");
    const noiseAccount = followers[5];
    const favouriter = followers[4];
    if (noise > 0 && noiseAccount && favouriter) {
      await seedNoise(noiseAccount.id, favouriter.id, noise);
    }
    patchD1();
    patchBindings();
    const target = bobStatuses[14] ?? "";
    await measure("verify_credentials", ta, "GET", "/api/v1/accounts/verify_credentials");
    await measure("home(20)", ta, "GET", "/api/v1/timelines/home?limit=20");
    await measure("public local(20)", ta, "GET", "/api/v1/timelines/public?local=true&limit=20");
    await measure("public(20)", ta, "GET", "/api/v1/timelines/public?limit=20");
    await measure("tag(20)", ta, "GET", "/api/v1/timelines/tag/qctag?limit=20");
    await measure("list(20)", ta, "GET", `/api/v1/timelines/list/${list}?limit=20`);
    await measure("status", ta, "GET", `/api/v1/statuses/${target}`);
    const shape = (value: unknown) => {
      const part = (key: string) => {
        const list = typeof value === "object" && value !== null ? Reflect.get(value, key) : [];
        return Array.isArray(list)
          ? list.map((item: unknown) =>
              typeof item === "object" && item !== null ? Reflect.get(item, "content") : item,
            )
          : list;
      };
      return JSON.stringify({ a: part("ancestors"), d: part("descendants") });
    };
    console.log(
      `CONTEXT_SHAPE|${shape(await measure("context(10 replies)", ta, "GET", `/api/v1/statuses/${root}/context`))}`,
    );
    console.log(
      `CONTEXT_SHAPE_MID|${shape((await call(ta, "GET", `/api/v1/statuses/${replyIds[4]}/context`)).json)}`,
    );
    await measure("account", ta, "GET", `/api/v1/accounts/${bob.id}`);
    await measure(
      "account statuses(20)",
      ta,
      "GET",
      `/api/v1/accounts/${bob.id}/statuses?limit=20`,
    );
    await measure(
      "relationships(2)",
      ta,
      "GET",
      `/api/v1/accounts/relationships?id[]=${bob.id}&id[]=${carol.id}`,
    );
    await measure("notifications(20)", ta, "GET", "/api/v1/notifications?limit=20");
    await measure("bookmarks(20)", ta, "GET", "/api/v1/bookmarks?limit=20");
    await measure("favourites(20)", ta, "GET", "/api/v1/favourites?limit=20");
    await measure("conversations", ta, "GET", "/api/v1/conversations");
    await measure("POST status(tag+mention)", ta, "POST", "/api/v1/statuses", {
      status: `hello #qctag @${bob.username}`,
    });
    await measure("POST favourite", ta, "POST", `/api/v1/statuses/${target}/favourite`);
    await measure("POST unfavourite", ta, "POST", `/api/v1/statuses/${target}/unfavourite`);
    await measure("POST reblog", ta, "POST", `/api/v1/statuses/${target}/reblog`);
    await measure("POST unreblog", ta, "POST", `/api/v1/statuses/${target}/unreblog`);
    await measure("POST bookmark", ta, "POST", `/api/v1/statuses/${target}/bookmark`);
    const someone = followers[0];
    if (someone) {
      await measure("POST follow", ta, "POST", `/api/v1/accounts/${someone.id}/follow`);
      await measure("POST unfollow", ta, "POST", `/api/v1/accounts/${someone.id}/unfollow`);
    }
  });
});
