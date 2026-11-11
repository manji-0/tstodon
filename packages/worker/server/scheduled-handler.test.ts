import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { handleScheduled } from "./scheduled-handler";

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleScheduled", () => {
  // At hours 0, 6, 12 and 18 both crons fire, so a job queued by both would run twice.
  it("queues each job on one of the two crons, never both", async () => {
    const hourlyKinds = await queuedKinds("17 * * * *");
    const sixHourlyKinds = await queuedKinds("17 */6 * * *");

    expect(hourlyKinds).toEqual(
      expect.arrayContaining([
        "ProcessExpiredPolls",
        "RefreshLinkCards",
        "BackfillRemoteTags",
        "BackfillLocalNoteTags",
        "RekeyLegacyMedia",
        "PublishScheduledStatuses",
        "CleanUpStatuses",
      ]),
    );
    expect(sixHourlyKinds).toEqual(
      expect.arrayContaining([
        "VacuumMediaAttachments",
        "VacuumActivities",
        "StripStoredMediaMetadata",
        "BackfillStoredMediaSizes",
      ]),
    );
    expect(hourlyKinds.filter((kind) => sixHourlyKinds.includes(kind))).toEqual([]);
  });
});
