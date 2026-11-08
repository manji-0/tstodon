import { OutboxJob, QuoteRetry } from "@tstodon/domain";
import { claimQuoteRefresh, findStaleQuoteRefresh } from "./quote-store";

/** A pending quote by a remote note to check again: its quoted note and the stamp the note named. */
export type QuoteRefetch = Readonly<{
  quoteId: string;
  quotedUri: string;
  approvalUri: string | undefined;
}>;

/**
 * Queue refetch `attempt` of a pending quote, after the delay
 * {@link QuoteRetry.refetchDelaySeconds} gives it, as Mastodon's
 * `RefetchAndVerifyQuoteWorker.perform_in` and its retries. Best effort: a
 * quote that is not queued waits for its note's next `Update`.
 */
export const enqueueQuoteRefetch = async (
  env: Env,
  refetch: QuoteRefetch,
  attempt: number,
): Promise<void> => {
  const job = OutboxJob.parse({
    kind: "RefetchAndVerifyQuote",
    quoteId: refetch.quoteId,
    quotedUri: refetch.quotedUri,
    ...(refetch.approvalUri === undefined ? {} : { approvalUri: refetch.approvalUri }),
    attempt,
  });
  if (job.isErr()) {
    return;
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job.value, {
      delaySeconds: QuoteRetry.refetchDelaySeconds(attempt, Math.random()),
    });
  } catch {
    console.error(
      JSON.stringify({ kind: "QuoteRefetchNotQueued", quoteId: refetch.quoteId, attempt }),
    );
  }
};

/**
 * Queue a refresh of the accepted quote a status makes on a remote stamp,
 * when it was last checked over {@link QuoteRetry.refreshIntervalMs} ago, as
 * Mastodon's `schedule_refresh_if_stale!` when the status is shown. The
 * quote is claimed first, so other views queue nothing until the interval
 * passes again; a claim whose job cannot be queued is given back. Off the
 * request path: the view renders what is stored.
 */
export const requestQuoteRefresh = async (env: Env, statusId: string): Promise<void> => {
  const now = Date.now();
  const stale = await findStaleQuoteRefresh(
    env.DB,
    statusId,
    new Date(now - QuoteRetry.refreshIntervalMs).toISOString(),
  );
  if (stale.isErr() || stale.value === undefined) {
    return;
  }
  const claimedAt = new Date(now).toISOString();
  const claimed = await claimQuoteRefresh(env.DB, stale.value.id, stale.value.updatedAt, claimedAt);
  if (claimed.isErr() || !claimed.value) {
    return;
  }
  const job = OutboxJob.parse({ kind: "RefreshQuote", quoteId: stale.value.id });
  if (job.isErr()) {
    return;
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job.value, {
      delaySeconds: QuoteRetry.refreshDelaySeconds(Math.random()),
    });
  } catch {
    console.error(JSON.stringify({ kind: "QuoteRefreshNotQueued", quoteId: stale.value.id }));
    await claimQuoteRefresh(env.DB, stale.value.id, claimedAt, stale.value.updatedAt);
  }
};
