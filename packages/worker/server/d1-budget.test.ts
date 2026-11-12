import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { accessTokenFor, signedInAccount } from "../test/auth-fixture";
import { meter, patchD1, resetMeter, seedNoise, settle } from "../test/meter";

/**
 * D1 bills every row a query reads. A read endpoint whose rows read grows
 * with tables it does not show (a scan, a COUNT(*) over an author's history)
 * stays cheap in tests and costs the instance's quota in production. Each
 * endpoint here is measured before and after seeding rows it must not read;
 * its rows read may not grow by more than a page's worth.
 */

const NOISE = 3_000;
/** Allowed growth in rows read: well under the noise, well over a page. */
const MAX_GROWTH = 200;

const get = async (token: string, path: string): Promise<number> => {
  await settle();
  resetMeter();
  const response = await SELF.fetch(`https://example.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status, path).toBe(200);
  await response.text();
  await settle();
  return meter.tally.rowsRead;
};

const post = async (token: string, path: string, body?: unknown): Promise<unknown> => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response.json();
};

const idOf = (value: unknown): string => {
  const id = typeof value === "object" && value !== null ? Reflect.get(value, "id") : undefined;
  if (typeof id !== "string") {
    throw new Error(`no id in ${JSON.stringify(value)}`);
  }
  return id;
};

describe("D1 rows read do not grow with unrelated rows", () => {
  it(
    "keeps every read endpoint's rows read independent of table size",
    { timeout: 120_000 },
    async () => {
      const [reader, author, noisy, fan] = await Promise.all(
        ["budget-reader", "budget-author", "budget-noisy", "budget-fan"].map((name) =>
          signedInAccount(`${name}@example.com`),
        ),
      );
      if (!reader || !author || !noisy || !fan) throw new Error("accounts");
      const [readerToken, authorToken, fanToken] = await Promise.all(
        [reader, author, fan].map((account) => accessTokenFor(account.id)),
      );
      if (!readerToken || !authorToken || !fanToken) throw new Error("tokens");
      await post(readerToken, `/api/v1/accounts/${author.id}/follow`);
      await post(fanToken, `/api/v1/accounts/${reader.id}/follow`);
      const statuses: string[] = [];
      // More than a page, so the noise (older) never reaches a page.
      for (let n = 0; n < 25; n += 1) {
        statuses.push(
          idOf(
            await post(authorToken, "/api/v1/statuses", {
              status: `budget ${n} #budgettag @${reader.username}`,
            }),
          ),
        );
      }
      const first = statuses[0] ?? "";
      await post(readerToken, `/api/v1/statuses/${first}/favourite`);
      await post(readerToken, `/api/v1/statuses/${first}/bookmark`);
      await post(authorToken, "/api/v1/statuses", { status: "reply", in_reply_to_id: first });

      const paths = [
        "/api/v1/accounts/verify_credentials",
        "/api/v1/timelines/home?limit=20",
        "/api/v1/timelines/public?local=true&limit=20",
        "/api/v1/timelines/public?limit=20",
        "/api/v1/timelines/tag/budgettag?limit=20",
        `/api/v1/statuses/${first}`,
        `/api/v1/statuses/${first}/context`,
        `/api/v1/accounts/${author.id}`,
        `/api/v1/accounts/${author.id}/statuses?limit=20`,
        "/api/v1/notifications?limit=20",
        "/api/v1/bookmarks?limit=20",
        "/api/v1/favourites?limit=20",
      ];
      patchD1();
      const before = new Map<string, number>();
      for (const path of paths) {
        before.set(path, await get(readerToken, path));
      }
      // The noisy account posts on the public timeline (older than the page),
      // favourites its own posts and is notified; the reader sees none of it.
      await seedNoise(noisy.id, noisy.id, NOISE);
      const growth: Record<string, number> = {};
      for (const path of paths) {
        growth[path] = (await get(readerToken, path)) - (before.get(path) ?? 0);
      }
      for (const [path, rows] of Object.entries(growth)) {
        expect(
          rows,
          `${path} read ${rows} more rows after ${NOISE} unrelated statuses`,
        ).toBeLessThan(MAX_GROWTH);
      }
    },
  );
});
