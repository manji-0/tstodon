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
