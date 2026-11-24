import { env } from "cloudflare:workers";
import { defineQueue } from "void";
import { withMetricsBudget } from "#server/metrics";
import { handleQueue } from "#server/queue-handler";

// Fetch work a remote server sets off, kept off the delivery queue, as
// Mastodon's `pull` Sidekiq queue: a reply's thread job (`ResolveRemoteThread`)
// fetches a parent per job, and a forged chain can be 1000 parents long. One
// message a batch, so a slow fetch holds up no other job, and two consumers,
// so two chains go on side by side while the fetches stay few.
export const maxBatchSize = 1;
export const maxBatchTimeout = 0;
export const maxRetries = 3;
export const maxConcurrency = 2;
// Not a Void option: `queueDeadLetterQueues` in `void-plugins.ts` writes it.
export const deadLetterQueue = "tstodon-outbox-dlq";

// Void types its `env` argument loosely; the module `env` carries the generated `Env`.
export default defineQueue((batch) =>
  withMetricsBudget(env, "queue", () => handleQueue(batch, env)),
);
