import type { OutboxJob } from "@tstodon/domain";

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
