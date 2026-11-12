import { env } from "cloudflare:test";
import type { OutboxJob } from "@tstodon/domain";
import { describe, expect, it, vi } from "vite-plus/test";
import { runOrQueue } from "./inline-job";

const JOB = { kind: "ProcessExpiredPolls" } as const satisfies OutboxJob;

/** What `runOrQueue` sent to the queue when the job's run ended with `outcome`. */
const queuedAfter = async (run: () => Promise<"ok" | "retry">): Promise<unknown[]> => {
  const sent: unknown[] = [];
  const recording = new Proxy(env, {
    get: (target, key) =>
      key === "OUTBOX_PROCESS_QUEUE"
        ? { send: async (message: unknown) => void sent.push(message) }
        : Reflect.get(target, key),
  });
  await runOrQueue(recording, JOB, run);
  return sent;
};

describe("runOrQueue", () => {
  it("queues nothing for a job that ran", async () => {
    expect(await queuedAfter(async () => "ok")).toEqual([]);
  });

  it("queues the job for the queue's retries when it asks for one or throws", async () => {
    expect(await queuedAfter(async () => "retry")).toEqual([JOB]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await queuedAfter(async () => {
        throw new Error("D1 unavailable");
      }),
    ).toEqual([JOB]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("InlineJobThrew"));
    logged.mockRestore();
  });
});
