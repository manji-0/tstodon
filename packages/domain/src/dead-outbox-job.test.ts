import { err, ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import { DeadOutboxJob } from "./dead-outbox-job";
import { OutboxJob } from "./outbox-job";

const job = { kind: "ProcessExpiredPolls" } as const;

describe("DeadOutboxJob.classify", () => {
  it("reads the handler's envelope as a job that ran out of retries", () => {
    const entry = DeadOutboxJob.classify(DeadOutboxJob.envelope(job, 3), 1);
    expect(entry).toEqual({
      jobKind: "ProcessExpiredPolls",
      body: job,
      attempts: 3,
      reason: { kind: "RetriesExhausted" },
    });
    expect(DeadOutboxJob.describe(entry)).toBe("returned retry on each of 3 attempts");
  });

  it("reads a valid job Queues moved itself as a handler failure", () => {
    const entry = DeadOutboxJob.classify(job, 4);
    expect(entry.reason).toEqual({ kind: "HandlerFailed" });
    expect(entry.attempts).toBe(4);
    expect(entry.body).toBe(job);
  });

  it("keeps a body that is not a job, with what is wrong with it", () => {
    const entry = DeadOutboxJob.classify({ kind: "NoSuchJob", x: 1 }, 4);
    expect(entry.jobKind).toBe("NoSuchJob");
    expect(entry.reason.kind).toBe("Unparseable");
    expect(DeadOutboxJob.describe(entry)).toMatch(/^not an OutboxJob: /);
    expect(DeadOutboxJob.classify("text", 4).jobKind).toBe("Unknown");
    expect(DeadOutboxJob.classify(null, 4).reason.kind).toBe("Unparseable");
  });

  it("does not take an envelope as a job, so it never runs as one", () => {
    expect(OutboxJob.parse(DeadOutboxJob.envelope(job, 3)).isErr()).toBe(true);
  });
});

describe("DeadOutboxJob.requeue", () => {
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: index.toString(16).padStart(64, "0"),
      body: { kind: "ProcessExpiredPolls", n: index },
    }));

  it("sends the page back before deleting its rows, and chains after a full page", async () => {
    const calls: string[] = [];
    const page = await DeadOutboxJob.requeue(
      {
        list: async (select, before, limit) => {
          calls.push(`list ${select.kind} ${before} ${limit}`);
          return ok(rows(limit));
        },
        send: async (bodies) => {
          calls.push(`send ${bodies.length}`);
        },
        remove: async (ids) => {
          calls.push(`remove ${ids.length}`);
          return ok(undefined);
        },
      },
      { kind: "All" },
      "2026-11-09T00:00:00.000Z",
    );
    expect(page._unsafeUnwrap()).toEqual({ requeued: DeadOutboxJob.requeuePage, chained: true });
    expect(calls).toEqual([
      `list All 2026-11-09T00:00:00.000Z ${DeadOutboxJob.requeuePage}`,
      `send ${DeadOutboxJob.requeuePage}`,
      `remove ${DeadOutboxJob.requeuePage}`,
    ]);
  });

  it("does nothing with an empty page and stops after a short one", async () => {
    let sent = 0;
    const deps = (count: number) => ({
      list: async () => ok(rows(count)),
      send: async () => {
        sent += 1;
      },
      remove: async () => ok(undefined),
    });
    const empty = await DeadOutboxJob.requeue(deps(0), { kind: "All" }, "x");
    expect(empty._unsafeUnwrap()).toEqual({ requeued: 0, chained: false });
    expect(sent).toBe(0);
    const short = await DeadOutboxJob.requeue(deps(2), { kind: "All" }, "x");
    expect(short._unsafeUnwrap()).toEqual({ requeued: 2, chained: false });
  });

  it("fails when the rows cannot be read, without sending anything", async () => {
    let sent = false;
    const page = await DeadOutboxJob.requeue(
      {
        list: async () => err({ kind: "RepositoryError", message: "down" } as const),
        send: async () => {
          sent = true;
        },
        remove: async () => ok(undefined),
      },
      { kind: "All" },
      "x",
    );
    expect(page.isErr()).toBe(true);
    expect(sent).toBe(false);
  });
});
