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

type Tally = { statements: number; rounds: number; batches: number; sql: string[] };

const tally: Tally = { statements: 0, rounds: 0, batches: 0, sql: [] };
let inFlight = 0;

const sqlOf = (statement: unknown): string => {
  const text =
    typeof statement === "object" && statement !== null
      ? Reflect.get(statement, "statement")
      : undefined;
  return typeof text === "string" ? text.replace(/\s+/g, " ").slice(0, 140) : "?";
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

const patchD1 = (): void => {
  const dbProto: Record<string, unknown> = Object.getPrototypeOf(env.DB);
  const stmtProto: Record<string, unknown> = Object.getPrototypeOf(env.DB.prepare("SELECT 1"));
  const marker = "__queryCountPatched";
  if (Reflect.get(dbProto, marker)) {
    return;
  }
  Reflect.set(dbProto, marker, true);
  for (const method of ["first", "run", "all", "raw"]) {
    const original = Reflect.get(stmtProto, method);
    if (typeof original !== "function") continue;
    Reflect.set(stmtProto, method, function (this: unknown, ...args: unknown[]) {
      return track(1, () => Reflect.apply(original, this, args), [sqlOf(this)]);
    });
  }
  const batch = Reflect.get(dbProto, "batch");
  if (typeof batch === "function") {
    Reflect.set(dbProto, "batch", function (this: unknown, statements: unknown[]) {
      tally.batches += 1;
      return track(
        statements.length,
        () => Reflect.apply(batch, this, [statements]),
        statements.map((statement) => `[batch] ${sqlOf(statement)}`),
      );
    });
  }
  const exec = Reflect.get(dbProto, "exec");
  if (typeof exec === "function") {
    Reflect.set(dbProto, "exec", function (this: unknown, ...args: unknown[]) {
      return track(1, () => Reflect.apply(exec, this, args));
    });
  }
};

const reset = (): void => {
  tally.statements = 0;
  tally.rounds = 0;
  tally.batches = 0;
  tally.sql = [];
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
  console.log(
    `QUERY_COUNT_ROW|${label}|${result.status}|${size}|${before.statements}|${before.rounds}|${before.batches}|${deferred}`,
  );
  const detail = Reflect.get(env, "QUERY_COUNT_SQL");
  if (typeof detail === "string" && detail !== "" && label.includes(detail)) {
    console.log(before.sql.map((line) => `QUERY_SQL ${line}`).join("\n"));
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

    patchD1();
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
