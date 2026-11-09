import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { OutboxJob } from "@tstodon/domain";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { newEntityId } from "./ids";
import {
  ANALYTICS_ENGINE_POINTS_PER_INVOCATION,
  measureJobPage,
  streamRenderTally,
  withMetricsBudget,
  writeMetric,
} from "./metrics";
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
  it("writes one point per pass and target with counts and timings", async () => {
    const recorded = recordingEnv();
    const home = streamRenderTally(recorded.env, "home");
    await home.measure(async () => ok("event"));
    await home.measure(async () => ok(undefined));
    await home.measure(async () => ok("event"));
    const list = streamRenderTally(recorded.env, "list");
    await list.measure(async () => err("broken"));
    const idle = streamRenderTally(recorded.env, "public");
    home.flush();
    list.flush();
    idle.flush();
    expect(recorded.points).toEqual([
      {
        indexes: ["stream.render"],
        doubles: [
          3,
          2,
          0,
          expect.any(Number),
          expect.any(Number),
          expect.any(Number),
          expect.any(Number),
        ],
        blobs: ["home", "ok"],
      },
      {
        indexes: ["stream.render"],
        doubles: [
          1,
          0,
          1,
          expect.any(Number),
          expect.any(Number),
          expect.any(Number),
          expect.any(Number),
        ],
        blobs: ["list", "error"],
      },
    ]);
    // total >= max >= p95 >= p50 >= 0
    const [total = -1, max = -1, p50 = -1, p95 = -1] = recorded.points[0]?.doubles.slice(3) ?? [];
    expect(total).toBeGreaterThanOrEqual(max);
    expect(max).toBeGreaterThanOrEqual(p95);
    expect(p95).toBeGreaterThanOrEqual(p50);
    expect(p50).toBeGreaterThanOrEqual(0);
  });

  it("writes one point per FanOutRemovedStatuses job, not one per entry", async () => {
    const recorded = recordingEnv();
    const outcome = await processOutboxJob(
      recorded.env,
      job({
        kind: "FanOutRemovedStatuses",
        accountIds: [newEntityId(), newEntityId()],
        statusIds: [newEntityId(), newEntityId(), newEntityId()],
      }),
    );
    expect(outcome).toBe("ok");
    const renders = recorded.points.filter((point) => point.indexes[0] === "stream.render");
    expect(renders.map((point) => [point.blobs, point.doubles.slice(0, 3)])).toEqual([
      [
        ["home", "ok"],
        [6, 6, 0],
      ],
    ]);
  });

  it("starts over after a flush", async () => {
    const recorded = recordingEnv();
    const tally = streamRenderTally(recorded.env, "public");
    await tally.measure(async () => ok("event"));
    tally.flush();
    tally.flush();
    await tally.measure(async () => ok(undefined));
    tally.flush();
    expect(recorded.points.map((point) => point.doubles.slice(0, 3))).toEqual([
      [1, 1, 0],
      [1, 0, 0],
    ]);
  });
});

describe("metrics budget", () => {
  it("keeps one invocation under Analytics Engine's cap and reports what it dropped", async () => {
    const recorded = recordingEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await withMetricsBudget(recorded.env, "queue", async () => {
      for (let index = 0; index < ANALYTICS_ENGINE_POINTS_PER_INVOCATION + 40; index += 1) {
        writeMetric(recorded.env, index % 2 === 0 ? "stream.render" : "outbox.job.page", [index]);
      }
      return "done";
    });
    const logged = warn.mock.calls.map(([line]) => String(line));
    warn.mockRestore();
    expect(result).toBe("done");
    expect(recorded.points).toHaveLength(ANALYTICS_ENGINE_POINTS_PER_INVOCATION);
    expect(recorded.points.at(-1)).toEqual({
      indexes: ["metrics.dropped"],
      doubles: [41, ANALYTICS_ENGINE_POINTS_PER_INVOCATION - 1],
      blobs: ["queue", "outbox.job.page"],
    });
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] ?? "{}")).toEqual({
      kind: "MetricsDropped",
      source: "queue",
      written: ANALYTICS_ENGINE_POINTS_PER_INVOCATION - 1,
      dropped: { "stream.render": 20, "outbox.job.page": 21 },
    });
  });

  it("writes no summary when nothing was dropped, and a nested budget shares the outer one", async () => {
    const recorded = recordingEnv();
    await withMetricsBudget(
      recorded.env,
      "fetch",
      async () => {
        writeMetric(recorded.env, "search", [1]);
        await withMetricsBudget(recorded.env, "inner", async () => {
          writeMetric(recorded.env, "search", [2]);
          writeMetric(recorded.env, "search", [3]);
        });
      },
      3,
    );
    expect(recorded.points.map((point) => [point.indexes[0], point.doubles])).toEqual([
      ["search", [1]],
      ["search", [2]],
      ["metrics.dropped", [1, 2]],
    ]);
  });

  it("counts each invocation separately", async () => {
    const recorded = recordingEnv();
    const run = () =>
      withMetricsBudget(
        recorded.env,
        "fetch",
        async () => {
          writeMetric(recorded.env, "search", [1]);
        },
        2,
      );
    await run();
    await run();
    expect(recorded.points).toHaveLength(2);
  });

  it("never throws, even when the binding throws or the run fails", async () => {
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      withMetricsBudget(
        throwing,
        "fetch",
        async () => {
          writeMetric(throwing, "search", [1]);
          writeMetric(throwing, "search", [2]);
          throw new Error("handler failed");
        },
        1,
      ),
    ).rejects.toThrow("handler failed");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("logs a point dropped after the invocation settled", async () => {
    const recorded = recordingEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let late: Promise<void> = Promise.resolve();
    await withMetricsBudget(
      recorded.env,
      "fetch",
      async () => {
        writeMetric(recorded.env, "search", [1]);
        late = Promise.resolve().then(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          writeMetric(recorded.env, "search", [2]);
        });
      },
      2,
    );
    await late;
    const logged = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
    warn.mockRestore();
    expect(recorded.points).toHaveLength(1);
    expect(logged).toEqual([
      { kind: "MetricsDropped", source: "fetch", written: 1, dropped: { search: 1 }, late: true },
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
