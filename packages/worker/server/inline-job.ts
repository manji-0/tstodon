import type { OutboxJob } from "@tstodon/domain";
import { afterResponse } from "./after-response";

/**
 * Run a job here instead of sending it through the queue, and queue it only
 * when this attempt asks for a retry or throws, so the queue's retries and
 * dead-lettering still apply to it. A job that pages queues its next page
 * itself, as it does when the queue runs it.
 */
export const runOrQueue = async <Job extends OutboxJob>(
  env: Env,
  job: Job,
  run: (env: Env, job: Job) => Promise<"ok" | "retry">,
): Promise<void> => {
  const outcome = await run(env, job).catch((cause: unknown) => {
    console.error(
      JSON.stringify({
        kind: "InlineJobThrew",
        jobKind: job.kind,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    return "retry" as const;
  });
  if (outcome === "ok") {
    return;
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job);
  } catch {
    console.error(JSON.stringify({ kind: "InlineJobNotQueued", jobKind: job.kind }));
  }
};

/**
 * Where a job something sets off runs: `Inline`, here once the response is
 * ready ({@link runOrQueue}), or `Queued`, in a later queue invocation, for
 * work that sets off many such jobs and cannot afford them all in its own.
 */
export type JobStart = "Inline" | "Queued";

/** Start `job` as `start` says. Best effort: a job the queue refuses is logged and dropped. */
export const startJob = async <Job extends OutboxJob>(
  env: Env,
  job: Job,
  run: (env: Env, job: Job) => Promise<"ok" | "retry">,
  start: JobStart,
): Promise<void> => {
  if (start === "Inline") {
    afterResponse(job.kind, () => runOrQueue(env, job, run));
    return;
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job);
  } catch {
    console.error(JSON.stringify({ kind: "JobNotQueued", jobKind: job.kind }));
  }
};
