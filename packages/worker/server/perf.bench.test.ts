import { env, SELF } from "cloudflare:test";
import { describe, it } from "vite-plus/test";
import { z } from "zod";
import { accessTokenFor } from "../test/auth-fixture";
import { CELEB, HOT_ACTOR_URI, HOT_TAG, seedBench, VIEWER } from "../test/bench-seed";
import {
  meter,
  meterWork,
  patchBindings,
  patchD1,
  requestsSettled,
  resetMeter,
  settle,
  type StatementRows,
} from "../test/meter";
import { holdQueue, kindOf, QUEUE_BATCH } from "../test/queue-hold";
import { remoteActor } from "../test/remote-actor-fixture";
import { handleQueue } from "./queue-handler";

/**
 * The performance benchmark (`pnpm bench`, `docs/architecture/d1-heavy-scenarios.md#benchmark`):
 * seeds a realistic dataset (`test/bench-seed.ts`) and drives the hot paths
 * through the built Worker, printing for each one its wall time (p50 / p95 of
 * `BENCH_RUNS` runs), D1 statements, serial rounds and rows read and written.
 * Wall time is local Miniflare's: SQLite in-process, no D1 round trip. Rows
 * read and statements are what D1 bills and what scales with data.
 *
 * Skipped unless `BENCH=1`; `scripts/bench.mjs` sets it and parses the
 * `BENCH_*` lines into a table.
 */

const setting = (name: string): string => {
  const value: unknown = Reflect.get(env, name);
  return typeof value === "string" ? value : "";
};
const SCALE = Number(setting("BENCH_SCALE") || "1");
const RUNS = Number(setting("BENCH_RUNS") || "7");
/** `BENCH_PLAN=1` prints the query plan of each scenario's costliest statements. */
const PLANS = setting("BENCH_PLAN") === "1";
/** `BENCH_ONLY=<text>` runs only the requests and jobs whose label contains it. */
const ONLY = setting("BENCH_ONLY");
/** `BENCH_ANALYZE=1` runs `ANALYZE` after seeding, so plans use table statistics. */
const ANALYZE = setting("BENCH_ANALYZE") === "1";

type Sample = Readonly<{
  status: number;
  ms: number;
  statements: number;
  rounds: number;
  rowsRead: number;
  rowsWritten: number;
  deferred: number;
  rows: ReadonlyArray<StatementRows>;
}>;

const quantile = (values: ReadonlyArray<number>, q: number): number => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
};

const collapse = (sql: string) => sql.replace(/\s+/g, " ").trim();

const ExplainRows = z.array(z.object({ detail: z.string() }));

const explain = async (statement: StatementRows): Promise<string[]> => {
  try {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
      .bind(...statement.params)
      .all();
    return ExplainRows.parse(results).map((row) => row.detail);
  } catch (error) {
    return [`(no plan: ${String(error).slice(0, 120)})`];
  }
};

/** The statements that read the most rows, grouped by SQL text. */
const costliest = (rows: ReadonlyArray<StatementRows>, count: number) => {
  const bySql = new Map<
    string,
    { read: number; written: number; times: number; sample: StatementRows }
  >();
  for (const row of rows) {
    const key = collapse(row.sql);
    const entry = bySql.get(key) ?? { read: 0, written: 0, times: 0, sample: row };
    entry.read += row.rowsRead;
    entry.written += row.rowsWritten;
    entry.times += 1;
    if (row.rowsRead > entry.sample.rowsRead) entry.sample = row;
    bySql.set(key, entry);
  }
  return [...bySql.entries()]
    .toSorted(([, a], [, b]) => b.read + b.written - (a.read + a.written))
    .slice(0, count);
};

const report = async (label: string, samples: ReadonlyArray<Sample>) => {
  const median = (pick: (sample: Sample) => number) => quantile(samples.map(pick), 0.5);
  const statuses = [...new Set(samples.map((sample) => sample.status))].join("/");
  console.log(
    [
      "BENCH_ROW",
      label,
      statuses,
      samples.length,
      quantile(
        samples.map((s) => s.ms),
        0.5,
      ).toFixed(1),
      quantile(
        samples.map((s) => s.ms),
        0.95,
      ).toFixed(1),
      median((s) => s.statements),
      median((s) => s.rounds),
      median((s) => s.rowsRead),
      median((s) => s.rowsWritten),
      median((s) => s.deferred),
    ].join("|"),
  );
  const last = samples.at(-1);
  if (!last) return;
  for (const [sql, entry] of costliest(last.rows, 3)) {
    console.log(
      `BENCH_TOP|${label}|${entry.read}|${entry.written}|${entry.times}|${sql.slice(0, 400)}`,
    );
    if (PLANS) {
      for (const detail of await explain(entry.sample)) {
        console.log(`BENCH_PLAN|${label}|${sql.slice(0, 60)}|${detail}`);
      }
    }
  }
};

/** One request through the Worker, its after-response work counted and awaited. */
const sample = async (send: () => Promise<Response>): Promise<Sample> => {
  await settle();
  resetMeter();
  const startedAt = performance.now();
  const response = await send();
  await response.arrayBuffer();
  const ms = performance.now() - startedAt;
  const before = meter.tally.statements;
  const rounds = meter.tally.rounds;
  await requestsSettled();
  return {
    status: response.status,
    ms,
    statements: before,
    rounds,
    rowsRead: meter.tally.rowsRead,
    rowsWritten: meter.tally.rowsWritten,
    deferred: meter.tally.statements - before,
    rows: [...meter.tally.statementRows],
  };
};

const headers = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  "CF-Connecting-IP": "203.0.113.9",
});

const get = (token: string, path: string) => () =>
  SELF.fetch(`https://example.com${path}`, { headers: headers(token) });

const repeat = async (send: () => () => Promise<Response>, runs: number): Promise<Sample[]> => {
  await sample(send());
  const samples: Sample[] = [];
  for (let run = 0; run < runs; run += 1) {
    samples.push(await sample(send()));
  }
  return samples;
};

type JobStats = { invocations: Sample[]; messages: number; retries: number };

/** The invocations' sums, as one sample: a job's whole run across its pages. */
const total = (samples: ReadonlyArray<Sample>): Sample => ({
  status: 0,
  ms: samples.reduce((sum, s) => sum + s.ms, 0),
  statements: samples.reduce((sum, s) => sum + s.statements, 0),
  rounds: samples.reduce((sum, s) => sum + s.rounds, 0),
  rowsRead: samples.reduce((sum, s) => sum + s.rowsRead, 0),
  rowsWritten: samples.reduce((sum, s) => sum + s.rowsWritten, 0),
  deferred: 0,
  rows: samples.flatMap((s) => s.rows),
});

/** Run the held jobs as the queue would, `QUEUE_BATCH` per invocation, until none is left; timed per job kind. */
const drainTimed = async (held: Readonly<{ bodies: unknown[] }>, stats: Map<string, JobStats>) => {
  for (;;) {
    const taken = held.bodies.splice(0);
    if (taken.length === 0) return;
    const byKind = Map.groupBy(taken, (body) => String(kindOf(body)));
    for (const [kind, bodies] of byKind) {
      const entry = stats.get(kind) ?? { invocations: [], messages: 0, retries: 0 };
      stats.set(kind, entry);
      for (let start = 0; start < bodies.length; start += QUEUE_BATCH) {
        const batch = bodies.slice(start, start + QUEUE_BATCH);
        entry.messages += batch.length;
        resetMeter();
        const startedAt = performance.now();
        await meterWork(() =>
          handleQueue(
            {
              messages: batch.map((body) => ({
                body,
                attempts: 1,
                ack: () => undefined,
                retry: () => {
                  entry.retries += 1;
                },
              })),
            },
            env,
          ),
        );
        await settle();
        entry.invocations.push({
          status: 0,
          ms: performance.now() - startedAt,
          statements: meter.tally.statements,
          rounds: meter.tally.rounds,
          rowsRead: meter.tally.rowsRead,
          rowsWritten: meter.tally.rowsWritten,
          deferred: 0,
          rows: [...meter.tally.statementRows],
        });
      }
    }
  }
};

/** Delivery Workflows are not started: outbound HTTP is out of the benchmark's scope. */
const holdWorkflows = () => {
  const proto: object = Object.getPrototypeOf(env.OUTBOX_DELIVERY_WORKFLOW);
  const originals = {
    create: Reflect.get(proto, "create"),
    createBatch: Reflect.get(proto, "createBatch"),
  };
  const created = { count: 0 };
  Reflect.set(proto, "createBatch", (batch: unknown) => {
    created.count += Array.isArray(batch) ? batch.length : 1;
    return Promise.resolve([]);
  });
  Reflect.set(proto, "create", () => {
    created.count += 1;
    return Promise.resolve({ id: "held" });
  });
  return {
    created,
    release: () => {
      Reflect.set(proto, "create", originals.create);
      Reflect.set(proto, "createBatch", originals.createBatch);
    },
  };
};

/**
 * Every fifth account's home stream, open again: a hub that holds no socket
 * drops its subscriptions when a fan-out reaches it, so each post would
 * otherwise find fewer listeners than the last.
 */
const openHomeStreams = async () => {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO stream_subscriptions (hub, stream)
     SELECT id, 'user' FROM accounts WHERE access_email LIKE 'b%@bench.example'
       AND CAST(substr(username, 2) AS INTEGER) % 5 = 0`,
  ).run();
};

const CountRow = z.object({ n: z.number() });
const count = async (table: string): Promise<number> =>
  CountRow.parse(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;

describe.runIf(setting("BENCH") === "1")("performance benchmark", () => {
  it("drives the hot paths on the seeded dataset", { timeout: 3_600_000 }, async () => {
    const hot = await remoteActor("hot", "hot.bench.example");
    if (hot.actorUri !== HOT_ACTOR_URI) throw new Error(`hot actor at ${hot.actorUri}`);
    const seed = await seedBench(SCALE, ANALYZE);
    console.log(`BENCH_SEED|${seed.seconds.toFixed(1)}|${JSON.stringify(seed.shape)}`);
    for (const table of [
      "accounts",
      "remote_actors",
      "statuses",
      "remote_statuses",
      "follows",
      "outbound_follows",
      "remote_follows",
      "favourites",
      "notifications",
      "local_status_tags",
      "remote_status_tags",
      "media_attachments",
      "polls",
      "status_quotes",
      "account_list_members",
      "followed_tags",
    ]) {
      console.log(`BENCH_COUNT|${table}|${await count(table)}`);
    }

    const viewer = await accessTokenFor(seed.accountId(VIEWER));
    const celeb = await accessTokenFor(seed.accountId(CELEB));
    const plain = await accessTokenFor(seed.accountId(VIEWER + 10));
    // The last account follows only account 3, which posts about once in 300
    // statuses: a home page reaches back weeks.
    const sparseId = seed.accountId(seed.shape.localAccounts);
    await env.DB.prepare(
      "DELETE FROM follows WHERE follower_account_id = ? AND target_account_id <> ?",
    )
      .bind(sparseId, seed.accountId(3))
      .run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO follows (id, follower_account_id, target_account_id, kind) VALUES ('bench-sparse', ?, ?, 'Accepted')`,
    )
      .bind(sparseId, seed.accountId(3))
      .run();
    const sparse = await accessTokenFor(sparseId);
    // The second-to-last account follows 20 accounts other than the
    // celebrity, about one status in a hundred: a page takes hours.
    const mediumId = seed.accountId(seed.shape.localAccounts - 1);
    await env.DB.prepare(
      `DELETE FROM follows WHERE follower_account_id = ? AND target_account_id NOT IN (
         SELECT target_account_id FROM follows WHERE follower_account_id = ? AND target_account_id <> ? ORDER BY id LIMIT 20)`,
    )
      .bind(mediumId, mediumId, seed.accountId(CELEB))
      .run();
    const medium = await accessTokenFor(mediumId);
    patchD1();
    patchBindings();

    const oldest = seed.statusId(Math.floor(seed.shape.localStatuses / 2));
    const reads: ReadonlyArray<readonly [string, string, string]> = [
      ["verify_credentials", viewer, "/api/v1/accounts/verify_credentials"],
      ["home", viewer, "/api/v1/timelines/home?limit=20"],
      ["home max_id (15 days back)", viewer, `/api/v1/timelines/home?limit=20&max_id=${oldest}`],
      ["home (plain account)", plain, "/api/v1/timelines/home?limit=20"],
      ["home (sparse: follows one account)", sparse, "/api/v1/timelines/home?limit=20"],
      ["home (medium: follows 20 accounts)", medium, "/api/v1/timelines/home?limit=20"],
      ["public", viewer, "/api/v1/timelines/public?limit=20"],
      ["public local", viewer, "/api/v1/timelines/public?local=true&limit=20"],
      ["public remote", viewer, "/api/v1/timelines/public?remote=true&limit=20"],
      ["tag (hot)", viewer, `/api/v1/timelines/tag/${HOT_TAG}?limit=20`],
      ["tag (rare)", viewer, "/api/v1/timelines/tag/tag123?limit=20"],
      ["list", viewer, `/api/v1/timelines/list/${seed.listId}?limit=20`],
      ["notifications v1", viewer, "/api/v1/notifications?limit=20"],
      ["notifications v1 mentions", viewer, "/api/v1/notifications?limit=20&types[]=mention"],
      ["notifications v2 grouped", viewer, "/api/v2/notifications?limit=20"],
      ["notifications unread count", viewer, "/api/v1/notifications/unread_count"],
      [
        "account statuses (celebrity)",
        viewer,
        `/api/v1/accounts/${seed.accountId(CELEB)}/statuses?limit=20`,
      ],
      [
        "account statuses (no replies)",
        viewer,
        `/api/v1/accounts/${seed.accountId(VIEWER + 10)}/statuses?limit=20&exclude_replies=true`,
      ],
      [
        "status context (leaf)",
        viewer,
        `/api/v1/statuses/${seed.statusId(seed.threadLeaf)}/context`,
      ],
      [
        "status context (root)",
        viewer,
        `/api/v1/statuses/${seed.statusId(seed.threadRoot)}/context`,
      ],
      ["favourites", viewer, "/api/v1/favourites?limit=20"],
      ["search statuses", viewer, "/api/v2/search?q=status%20123&type=statuses&limit=5"],
      ["search accounts", viewer, "/api/v2/search?q=b12&type=accounts&limit=5"],
    ];
    for (const [label, token, path] of reads.filter(([label]) => label.includes(ONLY))) {
      await report(label, await repeat(() => get(token, path), RUNS));
    }

    if (ONLY !== "" && !["POST", "inbox", "job"].some((word) => ONLY.includes(word))) {
      return;
    }
    const jobs = new Map<string, JobStats>();
    const workflows = holdWorkflows();
    const held = holdQueue();
    try {
      const posts: Sample[] = [];
      const wholePost = new Map<string, Sample[]>();
      for (let run = 0; run < Math.max(3, Math.ceil(RUNS / 2)); run += 1) {
        await openHomeStreams();
        posts.push(
          await sample(() =>
            SELF.fetch("https://example.com/api/v1/statuses", {
              method: "POST",
              headers: { ...headers(celeb), "Content-Type": "application/json" },
              body: JSON.stringify({ status: `bench post ${run} #${HOT_TAG}` }),
            }),
          ),
        );
        const perPost = new Map<string, JobStats>();
        await drainTimed(held, perPost);
        for (const [kind, entry] of perPost) {
          const merged = jobs.get(kind) ?? { invocations: [], messages: 0, retries: 0 };
          merged.invocations.push(...entry.invocations);
          merged.messages += entry.messages;
          merged.retries += entry.retries;
          jobs.set(kind, merged);
          wholePost.set(kind, [...(wholePost.get(kind) ?? []), total(entry.invocations)]);
        }
      }
      await report("POST status (celebrity)", posts);
      for (const [kind, totals] of wholePost) {
        await report(`job ${kind}, whole run for one celebrity post`, totals);
      }
      // Five posts before the queue runs: their jobs share invocations, as
      // `maxBatchSize` lets them.
      const batched = new Map<string, JobStats>();
      await openHomeStreams();
      for (let run = 0; run < QUEUE_BATCH; run += 1) {
        await sample(() =>
          SELF.fetch("https://example.com/api/v1/statuses", {
            method: "POST",
            headers: { ...headers(celeb), "Content-Type": "application/json" },
            body: JSON.stringify({ status: `bench batched post ${run}` }),
          }),
        );
      }
      await drainTimed(held, batched);
      for (const [kind, entry] of batched) {
        await report(
          `job ${kind}, ${QUEUE_BATCH} posts queued (${entry.messages} msgs)`,
          entry.invocations,
        );
      }

      const creates: Sample[] = [];
      for (let run = 0; run < Math.max(3, Math.ceil(RUNS / 2)); run += 1) {
        const id = `${HOT_ACTOR_URI}/statuses/bench-${run}`;
        await openHomeStreams();
        creates.push(
          await sample(async () =>
            SELF.fetch(
              await hot.delivery({
                id: `${id}/activity`,
                type: "Create",
                to: ["https://www.w3.org/ns/activitystreams#Public"],
                cc: [`${HOT_ACTOR_URI}/followers`],
                object: {
                  id,
                  type: "Note",
                  attributedTo: HOT_ACTOR_URI,
                  content: `<p>hot note ${run}</p>`,
                  published: new Date().toISOString(),
                  to: ["https://www.w3.org/ns/activitystreams#Public"],
                  cc: [`${HOT_ACTOR_URI}/followers`],
                },
              }),
            ),
          ),
        );
        await drainTimed(held, jobs);
      }
      await report("inbox Create (hot actor)", creates);
    } finally {
      held.release();
      workflows.release();
    }
    for (const [kind, entry] of jobs) {
      await report(
        `job ${kind} (${entry.messages} msgs, ${entry.retries} retries)`,
        entry.invocations,
      );
    }
    console.log(`BENCH_WORKFLOWS|${workflows.created.count}`);
  });
});
