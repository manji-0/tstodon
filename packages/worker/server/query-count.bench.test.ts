import { env, SELF } from "cloudflare:test";
import { describe, it } from "vite-plus/test";
import { accessTokenFor, signedInAccount } from "../test/auth-fixture";
import { meter, patchBindings, patchD1, resetMeter, seedNoise, settle } from "../test/meter";

/**
 * Counts the D1 statements and serial D1 rounds each Mastodon API request
 * costs on one seeded scenario. Not an assertion suite: it prints a table
 * (`QUERY_COUNT_ROW` lines) for comparing implementations and branches.
 * Run with `pnpm build && QUERY_COUNT=1 pnpm vp test run --project worker query-count
 * --silent=false`; without `QUERY_COUNT=1` it is skipped.
 */

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
  resetMeter();
  const result = await call(token, method, path, body);
  const before = { ...meter.tally, sql: [...meter.tally.sql] };
  await settle();
  const deferred = meter.tally.statements - before.statements;
  const size = Array.isArray(result.json) ? result.json.length : "";
  // Rows and binding calls are totals, deferred work included: all of it is billed.
  console.log(
    `QUERY_COUNT_ROW|${label}|${result.status}|${size}|${before.statements}|${before.rounds}|${before.batches}|${deferred}|${meter.tally.rowsRead}|${meter.tally.rowsWritten}|${meter.tally.doRequests}|${meter.tally.queueMessages}|${meter.tally.kvReads}|${meter.tally.kvWrites}|${meter.tally.workflowCreates}`,
  );
  console.log(`QUERY_SHAPE|${label}|${normalizedBody(result.json)}`);
  const detail = Reflect.get(env, "QUERY_COUNT_SQL");
  if (typeof detail === "string" && detail !== "" && label.includes(detail)) {
    console.log(before.sql.map((line) => `QUERY_SQL ${line}`).join("\n"));
    console.log(
      meter.tally.rowsBySql
        .toSorted((left, right) => Number(right.split(" ")[0]) - Number(left.split(" ")[0]))
        .slice(0, 8)
        .map((line) => `QUERY_ROWS ${line}`)
        .join("\n"),
    );
    console.log(
      meter.tally.sql
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
