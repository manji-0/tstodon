import { env } from "cloudflare:workers";
import { defineQueue } from "void";
import { withMetricsBudget } from "#server/metrics";
import { handleQueue } from "#server/queue-handler";

export const maxBatchSize = 10;
export const maxBatchTimeout = 0;
export const maxRetries = 3;
// Not Void options: `queueConsumerOptions` in `void-plugins.ts` writes them.
export const maxConcurrency = 1;
// A message Queues gives up on after `maxRetries` (the handler threw, or the
// body never parsed) moves here, as does a job the handler gives up on.
export const deadLetterQueue = "tstodon-outbox-dlq";

// Void types its `env` argument loosely; the module `env` carries the generated `Env`.
// One batch is one invocation: its metric writes share one data point budget.
export default defineQueue((batch) =>
  withMetricsBudget(env, "queue", () => handleQueue(batch, env)),
);
