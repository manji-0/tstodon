import { AsyncLocalStorage } from "node:async_hooks";
import type { Result } from "neverthrow";

/**
 * Analytics Engine's documented cap on data points one Worker invocation may
 * write (Cloudflare's Analytics Engine limits page, "250 data points per
 * Worker invocation"); writes past it are dropped by the platform without an
 * error. Checked against the docs in November 2026.
 */
export const ANALYTICS_ENGINE_POINTS_PER_INVOCATION = 250;

/** What one invocation has written, and what it left out once the budget ran out. */
type MetricsBudget = {
  readonly source: string;
  /** Points `writeMetric` may write; one more is kept for the `metrics.dropped` summary. */
  readonly limit: number;
  written: number;
  readonly dropped: Map<string, number>;
  reported: boolean;
};

const budgets = new AsyncLocalStorage<MetricsBudget>();

type Point = Readonly<{ indexes: string[]; doubles: number[]; blobs: string[] }>;

const writePoint = (env: Env, point: Point): void => {
  try {
    env.METRICS.writeDataPoint(point);
  } catch {
    // ignore
  }
};

const droppedTotal = (budget: MetricsBudget): number =>
  [...budget.dropped.values()].reduce((sum, count) => sum + count, 0);

/** The index that lost the most points (ties: the first to lose one). */
const mostDropped = (budget: MetricsBudget): string =>
  [...budget.dropped.entries()].reduce<[string, number]>(
    (top, entry) => (entry[1] > top[1] ? entry : top),
    ["", 0],
  )[0];

const logDropped = (budget: MetricsBudget, late: boolean): void => {
  console.warn(
    JSON.stringify({
      kind: "MetricsDropped",
      source: budget.source,
      written: budget.written,
      dropped: Object.fromEntries(budget.dropped),
      ...(late ? { late: true } : {}),
    }),
  );
};

/**
 * Write the `metrics.dropped` point (doubles `[droppedPoints, writtenPoints]`,
 * blobs `[source, indexThatLostMost]`) into the slot kept for it, and log
 * `MetricsDropped` with the count per index.
 */
const reportDropped = (env: Env, budget: MetricsBudget): void => {
  budget.reported = true;
  const total = droppedTotal(budget);
  if (total === 0) {
    return;
  }
  writePoint(env, {
    indexes: ["metrics.dropped"],
    doubles: [total, budget.written],
    blobs: [budget.source, mostDropped(budget)],
  });
  logDropped(budget, false);
};

/**
 * Run one Worker invocation (a request, a queue batch, a cron run, a Workflow
 * run) under a data point budget: past `limit - 1` points `writeMetric` stops
 * writing and counts what it left out, and when `run` settles one
 * `metrics.dropped` point reports the count. A nested call shares the outer
 * budget. Points written after `run` settles (a `waitUntil` that outlives it)
 * still count; one dropped then is logged, as there is no slot left to say so.
 */
export const withMetricsBudget = async <T>(
  env: Env,
  source: string,
  run: () => Promise<T>,
  limit: number = ANALYTICS_ENGINE_POINTS_PER_INVOCATION,
): Promise<T> => {
  if (budgets.getStore()) {
    return run();
  }
  const budget: MetricsBudget = {
    source,
    limit: Math.max(0, limit - 1),
    written: 0,
    dropped: new Map(),
    reported: false,
  };
  try {
    return await budgets.run(budget, run);
  } finally {
    reportDropped(env, budget);
  }
};

/**
 * Best-effort Analytics Engine writes. Must never throw into request/queue paths.
 * Inside `withMetricsBudget` a write past the budget is counted, not sent.
 * Convention (see docs/architecture/d1-heavy-scenarios.md):
 * - indexes[0]: path key (e.g. outbox.expand, search, timeline.tag)
 * - doubles: path-specific numeric fields (counts, ms)
 * - blobs: low-cardinality labels (type, cron, …) — avoid raw PII
 */
export const writeMetric = (
  env: Env,
  index: string,
  doubles: ReadonlyArray<number>,
  blobs: ReadonlyArray<string> = [],
): void => {
  const budget = budgets.getStore();
  if (budget) {
    if (budget.written >= budget.limit) {
      const first = droppedTotal(budget) === 0;
      budget.dropped.set(index, (budget.dropped.get(index) ?? 0) + 1);
      if (budget.reported && first) {
        logDropped(budget, true);
      }
      return;
    }
    budget.written += 1;
  }
  writePoint(env, { indexes: [index], doubles: [...doubles], blobs: [...blobs] });
};

export const elapsedMs = (startedAt: number): number => Math.max(0, Date.now() - startedAt);

/**
 * One timeline request. Index `timeline.<name>`; doubles `[latencyMs, rows]`;
 * blobs `[ok | error]`. `rows` is `undefined` when the request failed.
 */
export const writeTimelineMetric = (
  env: Env,
  name: "home" | "list" | "public" | "tag",
  startedAt: number,
  rows: number | undefined,
): void => {
  writeMetric(
    env,
    `timeline.${name}`,
    [elapsedMs(startedAt), rows ?? 0],
    [rows === undefined ? "error" : "ok"],
  );
};

/** What one queue pass of a paged job did. */
export type JobPage = Readonly<{
  outcome: "ok" | "retry";
  /** Recipients or rows handled; -1 when the job cannot tell. */
  size: number;
  /** The pass queued a follow-up page. */
  chained: boolean;
  /** Which step of a multi-step job ran (CSV `Rows`/`Prune`, move phase); empty when it has one. */
  step?: string;
}>;

/**
 * Run one pass of a paged job and write its `outbox.job.page` point: doubles
 * `[size, elapsedMs, chainedFlag]`, blobs `[jobKind, outcome, step]`. A pass
 * that throws is recorded as `error` and the error goes on.
 */
export const measureJobPage = async (
  env: Env,
  kind: string,
  run: () => Promise<JobPage>,
): Promise<"ok" | "retry"> => {
  const startedAt = Date.now();
  try {
    const page = await run();
    writeMetric(
      env,
      "outbox.job.page",
      [page.size, elapsedMs(startedAt), page.chained ? 1 : 0],
      [kind, page.outcome, page.step ?? ""],
    );
    return page.outcome;
  } catch (error) {
    writeMetric(env, "outbox.job.page", [0, elapsedMs(startedAt), 0], [kind, "error", ""]);
    throw error;
  }
};

const quantile = (sorted: ReadonlyArray<number>, q: number): number =>
  sorted.length === 0
    ? 0
    : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);

/** Renders one fan-out pass did for one target, written as one point. */
export type StreamRenderTally = Readonly<{
  /** Render one stream event for one recipient and count it. */
  measure: <T, E>(
    render: () => Promise<Result<T | undefined, E>>,
  ) => Promise<Result<T | undefined, E>>;
  /** Write the `stream.render` point, when anything was rendered, and start over. */
  flush: () => void;
}>;

/**
 * One `stream.render` point per fan-out pass and target, not per recipient
 * (Analytics Engine caps the points one invocation writes): doubles
 * `[renders, delivered, errors, totalMs, maxMs, p50Ms, p95Ms]`, blobs
 * `[home | list | public, ok | error]` (`error` when any render failed).
 * `delivered` counts the recipients whose timeline holds the entry.
 */
export const streamRenderTally = (
  env: Env,
  target: "home" | "list" | "public",
): StreamRenderTally => {
  let timings: number[] = [];
  let delivered = 0;
  let errors = 0;
  return {
    measure: async (render) => {
      const startedAt = Date.now();
      const rendered = await render();
      timings.push(elapsedMs(startedAt));
      if (rendered.isErr()) {
        errors += 1;
      } else if (rendered.value !== undefined) {
        delivered += 1;
      }
      return rendered;
    },
    flush: () => {
      if (timings.length === 0) {
        return;
      }
      const sorted = [...timings].sort((a, b) => a - b);
      writeMetric(
        env,
        "stream.render",
        [
          sorted.length,
          delivered,
          errors,
          sorted.reduce((sum, ms) => sum + ms, 0),
          sorted.at(-1) ?? 0,
          quantile(sorted, 0.5),
          quantile(sorted, 0.95),
        ],
        [target, errors > 0 ? "error" : "ok"],
      );
      timings = [];
      delivered = 0;
      errors = 0;
    },
  };
};
