import type { AccountId, OutboxJob } from "@tstodon/domain";
import { generateAnnualReport } from "./annual-report-store";

type GenerateJob = Extract<OutboxJob, { kind: "GenerateAnnualReport" }>;

/**
 * Queue the generation of an account's report, as Mastodon's
 * `GenerateAnnualReportWorker.perform_async`: its reads span the account's
 * whole year, more than a request should wait on. False when the queue
 * refused it.
 */
export const queueAnnualReportGeneration = async (
  env: Env,
  accountId: AccountId,
  year: number,
): Promise<boolean> => {
  const job: GenerateJob = { kind: "GenerateAnnualReport", accountId, year };
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job);
    return true;
  } catch {
    console.error(JSON.stringify({ kind: "JobNotQueued", jobKind: job.kind }));
    return false;
  }
};

/** `GenerateAnnualReportWorker#perform`. */
export const processGenerateAnnualReportJob = async (
  env: Env,
  job: GenerateJob,
): Promise<"ok" | "retry"> =>
  (await generateAnnualReport(env.DB, job.accountId, job.year, new Date())).isOk() ? "ok" : "retry";
