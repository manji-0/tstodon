import type { Result } from "neverthrow";

/**
 * Best-effort Analytics Engine writes. Must never throw into request/queue paths.
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
  try {
    env.METRICS.writeDataPoint({
      indexes: [index],
      doubles: [...doubles],
      blobs: [...blobs],
    });
  } catch {
    // ignore
  }
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

/**
 * Render one stream event for one recipient. Index `stream.render`; doubles
 * `[renderMs, deliveredFlag]`; blobs `[home | list | public, ok | error]`.
 * `deliveredFlag` is 0 when the entry is not on the recipient's timeline.
 */
export const measureStreamRender = async <T, E>(
  env: Env,
  target: "home" | "list" | "public",
  render: () => Promise<Result<T | undefined, E>>,
): Promise<Result<T | undefined, E>> => {
  const startedAt = Date.now();
  const rendered = await render();
  writeMetric(
    env,
    "stream.render",
    [elapsedMs(startedAt), rendered.isOk() && rendered.value !== undefined ? 1 : 0],
    [target, rendered.isOk() ? "ok" : "error"],
  );
  return rendered;
};
