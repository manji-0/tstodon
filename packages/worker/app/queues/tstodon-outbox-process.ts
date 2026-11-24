import { env } from "cloudflare:workers";
import { defineQueue } from "void";
import { withMetricsBudget } from "#server/metrics";
import { handleQueue } from "#server/queue-handler";

// One batch is one invocation, whose D1 statements are capped at 1000. The
// costliest jobs (a remote note's queued recipient with its `direct` stream
// open) make about 83 each, so 5 keeps a batch near half the cap
// (`remote-note-recipients.test.ts` measures it).
export const maxBatchSize = 5;
export const maxBatchTimeout = 0;
export const maxRetries = 3;
export const maxConcurrency = 1;
// A message Queues gives up on after `maxRetries` (the handler threw, or the
// body never parsed) moves here, as does a job the handler gives up on.
// Not a Void option: `queueDeadLetterQueues` in `void-plugins.ts` writes it.
export const deadLetterQueue = "tstodon-outbox-dlq";

// Void types its `env` argument loosely; the module `env` carries the generated `Env`.
// One batch is one invocation: its metric writes share one data point budget.
export default defineQueue((batch) =>
  withMetricsBudget(env, "queue", () => handleQueue(batch, env)),
);
