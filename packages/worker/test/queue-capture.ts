import { env } from "cloudflare:test";
import { OutboxJob } from "@tstodon/domain";
import { type OutboxJobOutcome, processOutboxJob } from "../server/outbox-job";

/** `env` whose outbox queue keeps the jobs sent to it in `sent` instead of running them. */
export const queueCapturingEnv = (sent: OutboxJob[]): Env => {
  const queue = {
    send: async (message: unknown) => {
      const job = OutboxJob.parse(message);
      if (job.isOk()) {
        sent.push(job.value);
      }
    },
    sendBatch: async (messages: Iterable<{ body: unknown }>) => {
      for (const message of messages) {
        const job = OutboxJob.parse(message.body);
        if (job.isOk()) {
          sent.push(job.value);
        }
      }
    },
  };
  return new Proxy(env, {
    get: (target, key) => (key === "OUTBOX_PROCESS_QUEUE" ? queue : Reflect.get(target, key)),
  });
};

/**
 * Run the captured jobs of `kind` one at a time, as the queue would, until none
 * is left, each through `around` (to meter it). Jobs of other kinds are
 * dropped. Resolves to the outcome of each job run.
 */
export const drainJobs = async (
  target: Env,
  sent: OutboxJob[],
  kind: OutboxJob["kind"],
  around: (run: () => Promise<OutboxJobOutcome>) => Promise<OutboxJobOutcome> = (run) => run(),
): Promise<OutboxJobOutcome[]> => {
  const outcomes: OutboxJobOutcome[] = [];
  for (let job = sent.shift(); job !== undefined; job = sent.shift()) {
    const current = job;
    if (current.kind === kind) {
      outcomes.push(await around(() => processOutboxJob(target, current)));
    }
  }
  return outcomes;
};
