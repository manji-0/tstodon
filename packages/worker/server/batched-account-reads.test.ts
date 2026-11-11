import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiAccount } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  return { status: response.status, body: await response.json() };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const send = async (email: string, path: string, body: unknown = {}): Promise<unknown> => {
  const response = await json(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.body;
};

const accountIdFor = async (email: string): Promise<string> =>
  read(
    ApiAccount,
    (await json("/api/v1/accounts/verify_credentials", { headers: await authHeaders(email) })).body,
  ).id;

const postStatus = async (email: string, status: string): Promise<string> =>
  read(z.object({ id: z.string() }), await send(email, "/api/v1/statuses", { status })).id;

const directory = async (order: string): Promise<z.infer<typeof ApiAccount>[]> =>
  read(z.array(ApiAccount), (await json(`/api/v1/directory?order=${order}&limit=80`)).body);

const byId = (left: { id: string }, right: { id: string }): number =>
  left.id.localeCompare(right.id);

describe("GET /api/v1/directory", () => {
  it("lists accounts in order, each rendered as its own document", async () => {
    const quiet = await accountIdFor("dir-batch-quiet@example.com");
    const busy = await accountIdFor("dir-batch-busy@example.com");
    const newest = await accountIdFor("dir-batch-newest@example.com");
    await postStatus("dir-batch-busy@example.com", "one");
    await postStatus("dir-batch-busy@example.com", "two");
    await postStatus("dir-batch-newest@example.com", "three");
    await send("dir-batch-quiet@example.com", `/api/v1/accounts/${busy}/follow`);
    const mine = new Set([quiet, busy, newest]);

    const active = (await directory("active")).filter((account) => mine.has(account.id));
    expect(active.map((account) => account.id)).toEqual([busy, newest, quiet]);
    expect(active.map((account) => account.statuses_count)).toEqual([2, 1, 0]);
    expect(active[0]?.followers_count).toBe(1);
    expect(active[2]?.following_count).toBe(1);

    const recent = (await directory("new")).filter((account) => mine.has(account.id));
    expect(recent.map((account) => account.id)).toEqual([newest, busy, quiet]);
    expect(recent.toSorted(byId)).toEqual(active.toSorted(byId));
  });
});

const FilteredTimeline = z.array(
  z.object({
    id: z.string(),
    filtered: z
      .array(
        z.object({
          filter: z.object({
            id: z.string(),
            statuses: z.array(z.object({ id: z.string(), status_id: z.string() })),
          }),
        }),
      )
      .optional(),
  }),
);

describe("filters loaded for a timeline", () => {
  it("carries each filter's own statuses, in the order the filter lists them", async () => {
    const viewer = "filter-batch-viewer@example.com";
    const author = "filter-batch-author@example.com";
    const authorId = await accountIdFor(author);
    await send(viewer, `/api/v1/accounts/${authorId}/follow`);
    const shown = await postStatus(author, "alpha and beta together");
    const narrowed = [
      await postStatus(author, "first"),
      await postStatus(author, "second"),
      await postStatus(author, "third"),
    ];
    const filterIds: string[] = [];
    for (const keyword of ["alpha", "beta", "gamma-unused"]) {
      const created = await send(viewer, "/api/v2/filters", {
        title: keyword,
        context: ["home"],
        keywords: [keyword],
      });
      filterIds.push(read(z.object({ id: z.string() }), created).id);
    }
    const [alpha, beta] = filterIds;
    for (const [filterId, statusId] of [
      [alpha, narrowed[1]],
      [beta, narrowed[2]],
      [alpha, narrowed[0]],
    ]) {
      await send(viewer, `/api/v2/filters/${filterId}/statuses`, { status_id: statusId });
    }

    const home = read(
      FilteredTimeline,
      (await json("/api/v1/timelines/home", { headers: await authHeaders(viewer) })).body,
    );
    const filtered = home.find((status) => status.id === shown)?.filtered ?? [];
    expect(filtered).toHaveLength(2);
    expect(new Set(filtered.map((entry) => entry.filter.id))).toEqual(new Set([alpha, beta]));
    for (const entry of filtered) {
      const own = await json(`/api/v2/filters/${entry.filter.id}/statuses`, {
        headers: await authHeaders(viewer),
      });
      expect(entry.filter.statuses).toEqual(own.body);
    }
    expect(filtered.find((entry) => entry.filter.id === alpha)?.filter.statuses).toHaveLength(2);
  });
});
