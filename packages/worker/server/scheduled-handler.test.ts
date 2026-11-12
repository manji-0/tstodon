import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { authHeaders } from "../test/auth-fixture";
import {
  type CronJob,
  HOURLY_CRON,
  HOURLY_JOBS,
  SIX_HOURLY_JOBS,
  handleScheduled,
} from "./scheduled-handler";

const QUEUED: QueueSendResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
};

const queuedKinds = async (schedule: string): Promise<string[]> => {
  const send = vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "send").mockResolvedValue(QUEUED);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
  const ctx = createExecutionContext();
  await handleScheduled({ cron: schedule, scheduledTime: Date.now(), noRetry: () => {} }, env, ctx);
  await waitOnExecutionContext(ctx);
  const kinds = send.mock.calls.map(([body]) =>
    typeof body === "object" && body !== null && "kind" in body ? String(body.kind) : "",
  );
  vi.restoreAllMocks();
  return kinds;
};

const kindsOf = (jobs: ReadonlyArray<CronJob>, kind?: CronJob["kind"]): string[] =>
  jobs.filter((cronJob) => kind === undefined || cronJob.kind === kind).map(({ job }) => job.kind);

/** Jobs that queue their next page when a page is full. */
const PAGED = new Set([
  "BackfillRemoteTags",
  "BackfillLocalNoteTags",
  "FoldTagNames",
  "RekeyLegacyMedia",
  "VacuumMediaAttachments",
  "VacuumActivities",
  "BackfillStoredMediaSizes",
]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleScheduled", () => {
  // At hours 0, 6, 12 and 18 both crons fire, so a job of both would run twice.
  it("gives each job to one of the two crons, never both", () => {
    const sixHourly = kindsOf(SIX_HOURLY_JOBS);
    expect(kindsOf(HOURLY_JOBS).filter((kind) => sixHourly.includes(kind))).toEqual([]);
  });

  it("runs the inline jobs in the cron, and queues the others only when they have work", async () => {
    const hourly = await queuedKinds(HOURLY_CRON);
    const sixHourly = await queuedKinds("17 */6 * * *");

    // An inline job that pages may queue its next page; none is queued to start.
    for (const [queued, jobs] of [
      [hourly, HOURLY_JOBS],
      [sixHourly, SIX_HOURLY_JOBS],
    ] as const) {
      for (const kind of kindsOf(jobs, "Inline").filter((kind) => !PAGED.has(kind))) {
        expect(queued).not.toContain(kind);
      }
    }
    // Nothing is due on the test database: no scheduled post, no ended poll.
    expect(hourly).not.toContain("PublishScheduledStatuses");
    expect(hourly).not.toContain("ProcessExpiredPolls");
    expect(sixHourly).toContain("StripStoredMediaMetadata");
  });

  it("queues the scheduled posts job once a post is due", async () => {
    const scheduled = await SELF.fetch("https://example.com/api/v1/statuses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await authHeaders("cron-scheduled@example.com")),
      },
      body: JSON.stringify({
        status: "later",
        scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
    expect(scheduled.status).toBe(200);
    expect(await queuedKinds(HOURLY_CRON)).not.toContain("PublishScheduledStatuses");

    await env.DB.prepare("UPDATE scheduled_statuses SET scheduled_at = ?")
      .bind(new Date(Date.now() - 1_000).toISOString())
      .run();
    expect(await queuedKinds(HOURLY_CRON)).toContain("PublishScheduledStatuses");
  });
});
