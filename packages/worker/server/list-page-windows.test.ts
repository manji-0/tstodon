import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { accessTokenFor, signedInAccount } from "../test/auth-fixture";
import { meter, patchD1, requestsSettled, resetMeter } from "../test/meter";
import { FEED_PAGE_WINDOWS_MS } from "./id-cursor";
import { entityIdAt } from "./ids";

/**
 * A list page reads back from its top in windows (`FEED_PAGE_WINDOWS_MS`), as
 * home does. Each member gives up to a page's worth, so its rows read may not
 * grow with how many members wrote nothing the page shows (`pnpm bench`: about
 * 3,100 rows for a page of 20 from a list of 20 before the windows), and a
 * page the first windows do not fill is answered whole, in order, from below
 * them.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FIRST_WINDOW = FEED_PAGE_WINDOWS_MS[0] ?? 0;
const Ids = z.array(z.object({ id: z.string() }));

/** `count` public notes by `accountId`, one a minute up to `endMs`; their ids, newest first. */
const seedNotes = async (accountId: string, count: number, endMs: number): Promise<string[]> => {
  const notes = Array.from({ length: count }, (_, n) => {
    const at = endMs - n * 60_000;
    return { id: entityIdAt(at), at: new Date(at).toISOString() };
  });
  await env.DB.batch(
    notes.map((note) =>
      env.DB.prepare(
        `INSERT INTO statuses (id, account_id, kind, content_text, content_html, visibility, created_at, updated_at)
         VALUES (?, ?, 'LocalNote', 'walk', '<p>walk</p>', 'public', ?, ?)`,
      ).bind(note.id, accountId, note.at, note.at),
    ),
  );
  return notes.map((note) => note.id);
};

/** A list of `prefix`'s owner holding `members` accounts it follows; its id, the owner's token and the members' ids. */
const listOf = async (prefix: string, members: number) => {
  const owner = await signedInAccount(`${prefix}-owner@example.com`);
  const accounts = await Promise.all(
    Array.from({ length: members }, (_, n) => signedInAccount(`${prefix}-${n}@example.com`)),
  );
  await env.DB.batch(
    accounts.map((account) =>
      env.DB.prepare(
        "INSERT INTO follows (id, follower_account_id, target_account_id, kind) VALUES (?, ?, ?, 'Accepted')",
      ).bind(entityIdAt(Date.now()), owner.id, account.id),
    ),
  );
  const token = await accessTokenFor(owner.id);
  const send = async (path: string, body: unknown) => {
    const response = await SELF.fetch(`https://example.com${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  const listId = z
    .object({ id: z.string() })
    .parse(await send("/api/v1/lists", { title: prefix })).id;
  await send(`/api/v1/lists/${listId}/accounts`, {
    account_ids: accounts.map((account) => account.id),
  });
  return { listId, token, memberIds: accounts.map((account) => account.id) };
};

const page = async (token: string, listId: string, query: string) => {
  resetMeter();
  const response = await SELF.fetch(
    `https://example.com/api/v1/timelines/list/${listId}?${query}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(response.status).toBe(200);
  const ids = Ids.parse(await response.json()).map((entry) => entry.id);
  await requestsSettled();
  return { ids, rowsRead: meter.tally.rowsRead };
};

describe("list page windows", () => {
  it(
    "reads a page without reading a page's worth from every member",
    { timeout: 60_000 },
    async () => {
      const { listId, token, memberIds } = await listOf("list-walk", 10);
      const [busy, ...others] = memberIds;
      if (busy === undefined) throw new Error("members");
      const recent = await seedNotes(busy, 30, Date.now() - 1_000);
      patchD1();
      const before = await page(token, listId, "limit=20");
      for (const other of others) {
        await seedNotes(other, 25, Date.now() - 2 * FIRST_WINDOW);
      }
      const after = await page(token, listId, "limit=20");

      expect(after.ids).toEqual(recent.slice(0, 20));
      expect(before.ids).toEqual(after.ids);
      expect(
        after.rowsRead - before.rowsRead,
        `the list read ${after.rowsRead - before.rowsRead} more rows after ${others.length} members wrote older notes`,
      ).toBeLessThan(100);
    },
  );

  it("answers a page its first windows do not fill from below them, in order", async () => {
    const { listId, token, memberIds } = await listOf("list-walk-sparse", 2);
    const [first, second] = memberIds;
    if (first === undefined || second === undefined) throw new Error("members");
    const now = Date.now();
    const inWindow = await seedNotes(first, 3, now - HOUR);
    const thatWeek = await seedNotes(second, 10, now - 3 * FIRST_WINDOW);
    const older = await seedNotes(first, 30, now - 9 * DAY);
    const oldest = await seedNotes(second, 5, now - 20 * DAY);
    const all = [...inWindow, ...thatWeek, ...older, ...oldest];

    const top = await page(token, listId, "limit=20");
    expect(top.ids).toEqual(all.slice(0, 20));
    const next = await page(token, listId, `limit=20&max_id=${top.ids.at(-1) ?? ""}`);
    expect(next.ids).toEqual(all.slice(20, 40));
    const since = await page(token, listId, `limit=20&since_id=${all[25] ?? ""}`);
    expect(since.ids).toEqual(all.slice(0, 20));
    const min = await page(token, listId, `limit=5&min_id=${all[25] ?? ""}`);
    expect(min.ids).toEqual(all.slice(20, 25));
    const last = await page(token, listId, `limit=20&max_id=${all[39] ?? ""}`);
    expect(last.ids).toEqual(all.slice(40));
  });
});
