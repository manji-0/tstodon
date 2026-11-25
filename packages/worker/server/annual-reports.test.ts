import { env, SELF } from "cloudflare:test";
import {
  ApiAccount,
  ApiAnnualReports,
  ApiAnnualReportState,
  ApiAsyncRefresh,
  ApiInstance,
  ApiStatus,
} from "@tstodon/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { accessTokenFor, authHeaders, signedInAccount } from "../test/auth-fixture";
import { expectContract } from "../test/api-contract";
import { patchD1 } from "../test/meter";
import { drainHeld, holdQueue } from "../test/queue-hold";
import { newEntityId } from "./ids";

const CAMPAIGN_DAY = new Date("2025-12-15T12:00:00Z");

const call = async (path: string, init: RequestInit = {}) => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const text = await response.text();
  return {
    status: response.status,
    refresh: response.headers.get("Mastodon-Async-Refresh"),
    body: text.length > 0 ? JSON.parse(text) : undefined,
  };
};

const as = async (email: string) => ({ ...(await authHeaders(email)) });

const post = async (email: string, path: string, payload: Record<string, unknown> = {}) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await as(email)) },
    body: JSON.stringify(payload),
  });

const postStatus = async (email: string, payload: Record<string, unknown>): Promise<string> => {
  const response = await post(email, "/api/v1/statuses", payload);
  expect(response.status).toBe(200);
  return expectContract(ApiStatus, response.body).id;
};

const stateOf = async (email: string, year: number) => {
  const response = await call(`/api/v1/annual_reports/${year}/state`, {
    headers: await as(email),
  });
  expect(response.status).toBe(200);
  return {
    state: expectContract(ApiAnnualReportState, response.body).state,
    refresh: response.refresh,
  };
};

/** A status written straight to D1, `created_at` in the year given. */
const insertStatus = async (
  accountId: string,
  options: Readonly<{
    createdAt?: string;
    inReplyTo?: Readonly<{ id: string; accountId: string }>;
  }> = {},
): Promise<string> => {
  const id = newEntityId();
  await env.DB.prepare(
    `INSERT INTO statuses (id, account_id, kind, visibility, in_reply_to_id, in_reply_to_account_id,
       created_at, updated_at)
     VALUES (?1, ?2, 'LocalNote', 'public', ?3, ?4, ?5, ?5)`,
  )
    .bind(
      id,
      accountId,
      options.inReplyTo?.id ?? null,
      options.inReplyTo?.accountId ?? null,
      options.createdAt ?? "2025-06-01T00:00:00.000Z",
    )
    .run();
  return id;
};

describe("annual reports (Wrapstodon)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CAMPAIGN_DAY);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("generates the campaign year's report in a queued job and serves it until read", async () => {
    const email = "wrapped-owner@example.com";
    const owner = await signedInAccount(email);
    const fans = ["wrapped-fan-1@example.com", "wrapped-fan-2@example.com"];
    const lateFan = await signedInAccount(fans[1] ?? "");

    const top = await postStatus(email, { status: "my year in #Wrapped" });
    const second = await postStatus(email, { status: "more #wrapped" });
    await postStatus(email, { status: "a thread", in_reply_to_id: second });
    await postStatus(email, { status: "for followers", visibility: "private" });
    for (const fan of fans) {
      expect((await post(fan, `/api/v1/statuses/${top}/reblog`)).status).toBe(200);
    }
    expect((await post(fans[0] ?? "", `/api/v1/statuses/${second}/reblog`)).status).toBe(200);
    expect((await post(fans[0] ?? "", `/api/v1/accounts/${owner.id}/follow`)).status).toBe(200);
    expect((await post(fans[1] ?? "", `/api/v1/accounts/${owner.id}/follow`)).status).toBe(200);
    // A follow made last year and a status of last year are not the year's.
    await env.DB.prepare(
      `UPDATE follows SET created_at = '2024-03-01T00:00:00.000Z'
       WHERE target_account_id = ? AND follower_account_id = ?`,
    )
      .bind(owner.id, lateFan.id)
      .run();
    await insertStatus(owner.id, { createdAt: "2024-12-31T23:59:59.000Z" });
    const othersPost = await postStatus("wrapped-other@example.com", { status: "hello" });
    await postStatus(email, { status: "hi", in_reply_to_id: othersPost });

    const instance = await call("/api/v2/instance");
    expect(expectContract(ApiInstance, instance.body).wrapstodon).toBe(2025);
    expect(await stateOf(email, 2025)).toEqual({ state: "eligible", refresh: null });

    patchD1();
    const queued = holdQueue();
    try {
      const generate = await post(email, "/api/v1/annual_reports/2025/generate");
      expect(generate.status).toBe(202);
      expect(generate.body).toBeUndefined();
      const refresh = `id="wrapstodon:${owner.id}:2025", retry=2`;
      expect(generate.refresh).toBe(refresh);
      expect(await stateOf(email, 2025)).toEqual({ state: "generating", refresh });
      // Asking again while it runs queues nothing more.
      expect((await post(email, "/api/v1/annual_reports/2025/generate")).refresh).toBe(refresh);
      expect(queued.bodies).toEqual([
        { kind: "GenerateAnnualReport", accountId: owner.id, year: 2025 },
      ]);
      const running = await call(
        `/api/v1_alpha/async_refreshes/${encodeURIComponent(`wrapstodon:${owner.id}:2025`)}`,
        { headers: await as(email) },
      );
      expect(expectContract(ApiAsyncRefresh, running.body).async_refresh).toEqual({
        id: `wrapstodon:${owner.id}:2025`,
        status: "running",
        result_count: null,
      });
      // The job reads the year in a fixed number of statements.
      expect(await drainHeld(queued, ["GenerateAnnualReport"])).toBeLessThanOrEqual(6);
    } finally {
      queued.release();
    }

    expect(await stateOf(email, 2025)).toEqual({ state: "available", refresh: null });
    const finished = await call(
      `/api/v1_alpha/async_refreshes/${encodeURIComponent(`wrapstodon:${owner.id}:2025`)}`,
      { headers: await as(email) },
    );
    expect(expectContract(ApiAsyncRefresh, finished.body).async_refresh.status).toBe("finished");
    const notTheirs = await call(
      `/api/v1_alpha/async_refreshes/${encodeURIComponent(`wrapstodon:${owner.id}:2025`)}`,
      { headers: await as("wrapped-other@example.com") },
    );
    expect(notTheirs.status).toBe(404);

    const shown = await call("/api/v1/annual_reports/2025", { headers: await as(email) });
    expect(shown.status).toBe(200);
    const document = expectContract(ApiAnnualReports, shown.body);
    expect(document.annual_reports).toHaveLength(1);
    const [report] = document.annual_reports;
    expect(report).toMatchObject({
      year: 2025,
      schema_version: 2,
      account_id: owner.id,
      data: {
        archetype: "lurker",
        top_statuses: { by_reblogs: top, by_favourites: null, by_replies: null },
        // Five statuses of 2025 (the private one too), one follower of 2025.
        time_series: [{ month: 12, statuses: 5, followers: 1 }],
        // tstodon stores a hashtag's name folded to lower case.
        top_hashtags: [{ name: "wrapped", count: 2 }],
      },
    });
    expect(report?.share_url).toMatch(
      new RegExp(`^https://example\\.com/@${owner.username}/wrapstodon/2025/[0-9a-f]{16}$`),
    );
    expect(document.accounts.map((account) => expectContract(ApiAccount, account).id)).toEqual([
      owner.id,
    ]);
    expect(document.statuses.map((status) => status.id)).toEqual([top]);

    // The share link is a public page booting the `wrapstodon` pack from the report.
    const sharePath = new URL(report?.share_url ?? "").pathname;
    const page = await SELF.fetch(`https://example.com${sharePath}`, {
      headers: { Accept: "text/html" },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("public, max-age=600");
    const html = await page.text();
    expect(html).toContain('<div id="wrapstodon"></div>');
    const shared = /<script type="application\/json" id="wrapstodon-data">(.*?)<\/script>/s.exec(
      html,
    );
    const sharedData: unknown = JSON.parse(shared?.[1] ?? "null");
    expect(expectContract(ApiAnnualReports, sharedData).annual_reports).toEqual([report]);
    expect(sharedData).toMatchObject({ domain: "example.com" });
    const wrongKey = sharePath.replace(/[0-9a-f]{16}$/, "0000000000000000");
    expect((await SELF.fetch(`https://example.com${wrongKey}`)).status).toBe(404);

    const pending = await call("/api/v1/annual_reports", { headers: await as(email) });
    expect(
      expectContract(ApiAnnualReports, pending.body).annual_reports.map((r) => r.year),
    ).toEqual([2025]);
    const read = await post(email, "/api/v1/annual_reports/2025/read");
    expect(read).toMatchObject({ status: 200, body: {} });
    const none = expectContract(
      ApiAnnualReports,
      (await call("/api/v1/annual_reports", { headers: await as(email) })).body,
    );
    expect(none).toEqual({ annual_reports: [], accounts: [], statuses: [] });
    expect((await call("/api/v1/annual_reports/2025", { headers: await as(email) })).status).toBe(
      200,
    );

    // A report is generated once.
    const again = await post(email, "/api/v1/annual_reports/2025/generate");
    expect(again).toMatchObject({ status: 200, body: {}, refresh: null });
    expect((await call("/api/v1/annual_reports/2024", { headers: await as(email) })).status).toBe(
      404,
    );
    expect((await post(email, "/api/v1/annual_reports/2024/read")).status).toBe(404);
  });

  it("counts self-replies as posts and replies to others apart (Archetype)", async () => {
    const email = "wrapped-threader@example.com";
    const owner = await signedInAccount(email);
    const other = await signedInAccount("wrapped-threaded-to@example.com");
    const parent = await insertStatus(other.id);
    const own = await insertStatus(owner.id);
    for (let index = 0; index < 29; index += 1) {
      await insertStatus(owner.id);
    }
    for (let index = 0; index < 15; index += 1) {
      await insertStatus(owner.id, { inReplyTo: { id: own, accountId: owner.id } });
    }
    for (let index = 0; index < 85; index += 1) {
      await insertStatus(owner.id, { inReplyTo: { id: parent, accountId: other.id } });
    }

    const queued = holdQueue();
    try {
      expect((await post(email, "/api/v1/annual_reports/2025/generate")).status).toBe(202);
      await drainHeld(queued, ["GenerateAnnualReport"]);
    } finally {
      queued.release();
    }
    const document = expectContract(
      ApiAnnualReports,
      (await call("/api/v1/annual_reports/2025", { headers: await as(email) })).body,
    );
    // 45 posts (15 of them self-replies) and 85 replies: an oracle. Counting
    // the self-replies as replies would make a replier (100 > 2 × 30).
    expect(document.annual_reports[0]?.data).toMatchObject({
      archetype: "oracle",
      time_series: [{ month: 12, statuses: 130, followers: 0 }],
      // Never boosted, but its replies gave it counts, which Mastodon's
      // `joins(:status_stat)` also takes.
      top_statuses: { by_reblogs: own },
      top_hashtags: [],
    });
  });

  it("offers nothing outside December 10 to 31", async () => {
    vi.setSystemTime(new Date("2025-11-20T00:00:00Z"));
    const email = "wrapped-early@example.com";
    await postStatus(email, { status: "early #bird" });
    await postStatus(email, { status: "early #bird again" });

    expect(expectContract(ApiInstance, (await call("/api/v2/instance")).body).wrapstodon).toBe(
      null,
    );
    expect(await stateOf(email, 2025)).toEqual({ state: "ineligible", refresh: null });
    const queued = holdQueue();
    try {
      expect(await post(email, "/api/v1/annual_reports/2025/generate")).toMatchObject({
        status: 200,
        body: {},
        refresh: null,
      });
      expect(queued.bodies).toEqual([]);
    } finally {
      queued.release();
    }
  });

  it("is ineligible without a public post and a hashtag of the year", async () => {
    const email = "wrapped-quiet@example.com";
    await postStatus(email, { status: "no tags here" });
    expect(await stateOf(email, 2025)).toEqual({ state: "ineligible", refresh: null });
    await postStatus(email, { status: "only #private", visibility: "private" });
    expect(await stateOf(email, 2025)).toEqual({ state: "eligible", refresh: null });
    expect(await stateOf(email, 2024)).toEqual({ state: "ineligible", refresh: null });
  });

  it("reads under read:accounts and writes under write:accounts", async () => {
    const account = await signedInAccount("wrapped-scoped@example.com");
    const token = await accessTokenFor(account.id, ["read:accounts"]);
    const headers = { Authorization: `Bearer ${token}` };
    expect((await call("/api/v1/annual_reports/2025/state", { headers })).status).toBe(200);
    expect((await call("/api/v1/annual_reports", { headers })).status).toBe(200);
    expect(
      (await call("/api/v1/annual_reports/2025/generate", { method: "POST", headers })).status,
    ).toBe(403);
    expect((await call("/api/v1/annual_reports")).status).toBe(401);
  });
});
