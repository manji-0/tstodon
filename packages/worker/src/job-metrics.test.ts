import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { OutboxJob } from "@tstodon/domain";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { newEntityId } from "./ids";
import { measureJobPage, measureStreamRender } from "./metrics";
import { processOutboxJob } from "./outbox-job";
import { ok, err } from "neverthrow";
import { z } from "zod";

type Point = Readonly<{ indexes: string[]; doubles: number[]; blobs: string[] }>;

/** An env whose Analytics Engine binding records the points instead of writing them. */
const recordingEnv = (overrides: Record<string, unknown> = {}) => {
  const points: Point[] = [];
  const metrics = {
    writeDataPoint: (point: Point) => {
      points.push(point);
    },
  };
  const proxied = new Proxy(env, {
    get: (target, key) =>
      key === "METRICS"
        ? metrics
        : key in overrides
          ? overrides[String(key)]
          : Reflect.get(target, key),
  });
  return { env: proxied, points };
};

const pagePoints = (points: ReadonlyArray<Point>) =>
  points.filter((point) => point.indexes[0] === "outbox.job.page");

const job = (value: unknown): OutboxJob => {
  const parsed = OutboxJob.parse(value);
  if (parsed.isErr()) {
    throw new Error("job fixture rejected");
  }
  return parsed.value;
};

const quietJobs: ReadonlyArray<
  Readonly<{ name: string; value: unknown; step: string; size?: number }>
> = [
  {
    name: "FanOutHome",
    value: {
      kind: "FanOutHome",
      event: "update",
      entryId: newEntityId(),
      author: { kind: "LocalAccount", accountId: newEntityId() },
      afterAccountId: "",
    },
    step: "",
  },
  {
    name: "FanOutPublic",
    value: { kind: "FanOutPublic", event: "update", entryId: newEntityId(), afterHub: "" },
    step: "",
  },
  {
    name: "DistributePollUpdate",
    value: { kind: "DistributePollUpdate", pollId: newEntityId() },
    step: "",
  },
  {
    name: "BackfillRemoteOutbox",
    value: { kind: "BackfillRemoteOutbox", actorUri: "https://elsewhere.example/users/nobody" },
    step: "",
  },
  {
    name: "BackfillRemoteOutbox",
    value: {
      kind: "BackfillRemoteOutbox",
      actorUri: "https://elsewhere.example/users/nobody",
      from: { kind: "Page", pageUri: "https://elsewhere.example/outbox?page=2", depth: 1 },
    },
    step: "",
  },
  {
    name: "BackfillRemoteThread",
    value: { kind: "BackfillRemoteThread", statusId: newEntityId() },
    step: "",
    size: 0,
  },
  {
    name: "FanOutRemovedStatuses",
    value: {
      kind: "FanOutRemovedStatuses",
      accountIds: [newEntityId()],
      statusIds: [newEntityId()],
    },
    step: "",
    size: 1,
  },
  {
    name: "CleanUpAccountStatuses",
    value: { kind: "CleanUpAccountStatuses", accountId: newEntityId() },
    step: "",
  },
  {
    name: "ProcessCsvImport",
    value: {
      kind: "ProcessCsvImport",
      importId: newEntityId(),
      step: { kind: "Rows", afterPosition: 0 },
    },
    step: "Rows",
  },
];

describe("paged job metrics", () => {
  for (const { name, value, step, size: expectedSize = 0 } of quietJobs) {
    it(`${name} writes one outbox.job.page point`, async () => {
      const recorded = recordingEnv();
      expect(await processOutboxJob(recorded.env, job(value))).toBe("ok");
      const [point, ...rest] = pagePoints(recorded.points);
      expect(rest).toEqual([]);
      expect(point?.blobs).toEqual([name, "ok", step]);
      expect(point?.doubles).toHaveLength(3);
      const [size, elapsedMs, chained] = point?.doubles ?? [];
      expect(size).toBe(expectedSize);
      expect(elapsedMs).toBeGreaterThanOrEqual(0);
      expect(chained).toBe(0);
    });
  }

  it("MoveFollows reports its phase and an unknown size", async () => {
    const recorded = recordingEnv();
    const moved = job({
      kind: "MoveFollows",
      fromActorUri: "https://elsewhere.example/users/old",
      toActorUri: "https://elsewhere.example/users/new",
      phase: "blocks",
      afterId: "",
    });
    expect(await processOutboxJob(recorded.env, moved)).toBe("ok");
    const [point] = pagePoints(recorded.points);
    expect(point?.blobs).toEqual(["MoveFollows", "ok", "blocks"]);
    expect(point?.doubles[0]).toBe(-1);
  });

  it("records a retry when the instance identity is unreadable", async () => {
    const recorded = recordingEnv({ INSTANCE_DOMAIN: "" });
    const fanOut = job(quietJobs[0]?.value);
    expect(await processOutboxJob(recorded.env, fanOut)).toBe("retry");
    expect(pagePoints(recorded.points).map((point) => point.blobs)).toEqual([
      ["FanOutHome", "retry", ""],
    ]);
  });

  it("records the chain flag and size a pass reports", async () => {
    const recorded = recordingEnv();
    const outcome = await measureJobPage(recorded.env, "FanOutHome", async () => ({
      outcome: "ok",
      size: 20,
      chained: true,
    }));
    expect(outcome).toBe("ok");
    expect(recorded.points).toHaveLength(1);
    expect(recorded.points[0]?.doubles[0]).toBe(20);
    expect(recorded.points[0]?.doubles[2]).toBe(1);
  });

  it("records a pass that throws as an error and lets it through", async () => {
    const recorded = recordingEnv();
    await expect(
      measureJobPage(recorded.env, "MoveFollows", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(recorded.points[0]?.blobs).toEqual(["MoveFollows", "error", ""]);
  });

  it("never fails a job because the metric write fails", async () => {
    const throwing = new Proxy(env, {
      get: (target, key) =>
        key === "METRICS"
          ? {
              writeDataPoint: () => {
                throw new Error("analytics down");
              },
            }
          : Reflect.get(target, key),
    });
    const outcome = await measureJobPage(throwing, "FanOutHome", async () => ({
      outcome: "ok",
      size: 1,
      chained: false,
    }));
    expect(outcome).toBe("ok");
  });
});

describe("stream render metrics", () => {
  it("records latency, and whether the recipient got an event", async () => {
    const recorded = recordingEnv();
    await measureStreamRender(recorded.env, "home", async () => ok("event"));
    await measureStreamRender(recorded.env, "list", async () => ok(undefined));
    await measureStreamRender(recorded.env, "public", async () => err("broken"));
    expect(
      recorded.points.map((point) => [point.indexes[0], point.blobs, point.doubles[1]]),
    ).toEqual([
      ["stream.render", ["home", "ok"], 1],
      ["stream.render", ["list", "ok"], 0],
      ["stream.render", ["public", "error"], 0],
    ]);
  });
});

describe("timeline request metrics", () => {
  const request = async (email: string, path: string) => {
    const response = await SELF.fetch(`https://example.com${path}`, {
      headers: await authHeaders(email),
    });
    return response.status;
  };

  it("writes timeline.home, .list, .public and .tag points", async () => {
    const email = "job-metrics-timelines@example.com";
    await signedInAccount(email);
    const write = vi.spyOn(env.METRICS, "writeDataPoint");
    const created = await SELF.fetch("https://example.com/api/v1/lists", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({ title: "metrics" }),
    });
    const list = z.object({ id: z.string() }).parse(await created.json());
    for (const path of [
      "/api/v1/timelines/home",
      `/api/v1/timelines/list/${list.id}`,
      "/api/v1/timelines/public",
      "/api/v1/timelines/tag/metrics",
    ]) {
      expect(await request(email, path)).toBe(200);
    }
    const seen = write.mock.calls.map(([point]) => point);
    for (const name of ["home", "list", "public", "tag"]) {
      const point = seen.find((candidate) => candidate?.indexes?.[0] === `timeline.${name}`);
      expect(point?.blobs).toEqual(["ok"]);
      expect(point?.doubles).toEqual([expect.any(Number), 0]);
    }
    write.mockRestore();
  });
});
