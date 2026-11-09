import { env } from "cloudflare:workers";
import { defineQueue } from "void";
import { handleDeadLetterQueue } from "#server/dead-letter-queue";
import { withMetricsBudget } from "#server/metrics";
import { maxRetries as outboxMaxRetries } from "./tstodon-outbox-process";

// The outbox queue's dead-letter queue: each message is stored in
// `outbox_dead_jobs` for an operator to inspect and requeue (see the runbook).
export const maxBatchSize = 10;
export const maxBatchTimeout = 5;
// A message that cannot be stored is retried, then logged as lost.
export const maxRetries = 5;
export const maxConcurrency = 1;

// Void types its `env` argument loosely; the module `env` carries the generated `Env`.
export default defineQueue((batch) =>
  withMetricsBudget(env, "queue", () =>
    handleDeadLetterQueue(batch, env, {
      // What Queues moved here itself was delivered `max_retries` + 1 times.
      outboxAttempts: outboxMaxRetries + 1,
      maxAttempts: maxRetries + 1,
    }),
  ),
);
