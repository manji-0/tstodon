import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { accessTokenFor, signedInAccount } from "../test/auth-fixture";
import { meter, patchD1, requestsSettled, resetMeter } from "../test/meter";
import { entityIdAt } from "./ids";
import { FEED_PAGE_WINDOWS_MS } from "./id-cursor";

/**
 * A home page reads back from its top in windows (`FEED_PAGE_WINDOWS_MS`). Its
 * rows read may not grow with how much the followed authors wrote before the
 * page (`pnpm bench`: 81,671 rows for a page of 20 before the windows), and a
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

const home = async (token: string, query: string) => {
  resetMeter();
  const response = await SELF.fetch(`https://example.com/api/v1/timelines/home?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const ids = Ids.parse(await response.json()).map((entry) => entry.id);
  await requestsSettled();
  return { ids, rowsRead: meter.tally.rowsRead };
};

describe("home page windows", () => {
  it(
    "reads a page without reading the followed authors' history",
    { timeout: 60_000 },
    async () => {
      const [reader, author] = await Promise.all(
        ["walk-reader", "walk-author"].map((name) => signedInAccount(`${name}@example.com`)),
      );
      if (!reader || !author) throw new Error("accounts");
      await env.DB.prepare(
        "INSERT INTO follows (id, follower_account_id, target_account_id, kind) VALUES (?, ?, ?, 'Accepted')",
      )
        .bind(entityIdAt(Date.now()), reader.id, author.id)
        .run();
      const token = await accessTokenFor(reader.id);
      const recent = await seedNotes(author.id, 30, Date.now() - 1_000);
      patchD1();
      const before = await home(token, "limit=20");
      await seedNotes(author.id, 3_000, Date.now() - 2 * FIRST_WINDOW);
      const after = await home(token, "limit=20");

      expect(after.ids).toEqual(recent.slice(0, 20));
      expect(before.ids).toEqual(after.ids);
      expect(
        after.rowsRead - before.rowsRead,
        `home read ${after.rowsRead - before.rowsRead} more rows after 3,000 older notes`,
      ).toBeLessThan(200);
    },
  );

  it("answers a page its first windows do not fill from below them, in order", async () => {
    const [reader, author] = await Promise.all(
      ["walk-sparse-reader", "walk-sparse-author"].map((name) =>
        signedInAccount(`${name}@example.com`),
      ),
    );
    if (!reader || !author) throw new Error("accounts");
    await env.DB.prepare(
      "INSERT INTO follows (id, follower_account_id, target_account_id, kind) VALUES (?, ?, ?, 'Accepted')",
    )
      .bind(entityIdAt(Date.now()), reader.id, author.id)
      .run();
    const token = await accessTokenFor(reader.id);
    const now = Date.now();
    const inWindow = await seedNotes(author.id, 3, now - HOUR);
    const thatWeek = await seedNotes(author.id, 10, now - 3 * FIRST_WINDOW);
    const older = await seedNotes(author.id, 30, now - 9 * DAY);
    const all = [...inWindow, ...thatWeek, ...older];

    const first = await home(token, "limit=20");
    expect(first.ids).toEqual(all.slice(0, 20));
    const second = await home(token, `limit=20&max_id=${first.ids.at(-1) ?? ""}`);
    expect(second.ids).toEqual(all.slice(20, 40));
    const since = await home(token, `limit=20&since_id=${all[25] ?? ""}`);
    expect(since.ids).toEqual(all.slice(0, 20));
    const min = await home(token, `limit=5&min_id=${all[25] ?? ""}`);
    expect(min.ids).toEqual(all.slice(20, 25));
  });
});
