import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import type { LocalStatus } from "@tstodon/domain";
import { signedInAccount } from "../test/auth-fixture";
import { findStatusesByIds } from "./status-store";
import { viewableStatusIds } from "./visibility-guard";

/** `env.DB` that counts the statements run on it and the rows D1 read for them. */
const meteredDb = (): Readonly<{
  db: D1Database;
  usage: () => Readonly<{ statements: number; rowsRead: number }>;
}> => {
  let statements = 0;
  let rowsRead = 0;
  const metered = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, key) => {
        if (key === "bind") {
          return (...values: unknown[]) => metered(target.bind(...values));
        }
        if (key === "all") {
          return async () => {
            const result = await target.all();
            statements += 1;
            rowsRead += result.meta.rows_read;
            return result;
          };
        }
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const db = new Proxy(env.DB, {
    get: (target, key) => {
      if (key === "prepare") {
        return (sql: string) => metered(target.prepare(sql));
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, usage: () => ({ statements, rowsRead }) };
};

/**
 * A reply chain of `notes` statuses by `authors` in turn, each replying to the
 * one before it, with the given visibility per position. Returns the ids from
 * the root down.
 */
const chain = async (
  prefix: string,
  authors: ReadonlyArray<string>,
  visibilityAt: (index: number) => string,
  notes: number,
): Promise<string[]> => {
  const now = new Date().toISOString();
  const ids = Array.from(
    { length: notes },
    (_, index) => `${prefix}${index.toString().padStart(6, "0")}`,
  );
  const statements = ids.map((id, index) =>
    env.DB.prepare(
      `INSERT INTO statuses (id, account_id, kind, in_reply_to_id, content_text, content_html, visibility, created_at, updated_at)
       VALUES (?, ?, 'LocalNote', ?, 'note', '<p>note</p>', ?, ?, ?)`,
    ).bind(
      id,
      authors[index % authors.length],
      ids[index - 1] ?? null,
      visibilityAt(index),
      now,
      now,
    ),
  );
  for (let start = 0; start < statements.length; start += 100) {
    await env.DB.batch(statements.slice(start, start + 100));
  }
  return ids;
};

const nth = (ids: ReadonlyArray<string>, index: number): string => {
  const id = ids[index];
  if (id === undefined) {
    throw new Error(`no note ${index}`);
  }
  return id;
};

const mention = (statusId: string, accountId: string) =>
  env.DB.prepare("INSERT INTO status_mentions (status_id, account_id) VALUES (?, ?)")
    .bind(statusId, accountId)
    .run();

const loaded = async (ids: ReadonlyArray<string>): Promise<LocalStatus[]> => {
  const found = await findStatusesByIds(env.DB, [...ids]);
  if (found.isErr()) {
    throw new Error(found.error.message);
  }
  return ids.flatMap((id) => found.value.get(id) ?? []);
};

const DEPTH = 500;

describe("a deep direct reply chain checked in one batch", () => {
  it("shows every reply below a note that mentions the viewer, reading each note a bounded number of times", async () => {
    const author = (await signedInAccount("dcv-author@example.com")).id;
    const replier = (await signedInAccount("dcv-replier@example.com")).id;
    const viewer = (await signedInAccount("dcv-viewer@example.com")).id;
    const outsider = (await signedInAccount("dcv-outsider@example.com")).id;
    const ids = await chain("6dcv", [author, replier], () => "direct", DEPTH);
    await mention(nth(ids, 0), viewer);
    const statuses = await loaded(ids);
    expect(statuses).toHaveLength(DEPTH);

    const { db, usage } = meteredDb();
    expect([...(await viewableStatusIds(db, statuses, [], viewer))].sort()).toEqual(ids);
    expect([...(await viewableStatusIds(db, statuses, [], outsider))]).toEqual([]);
    const { statements, rowsRead } = usage();
    expect(statements).toBe(2);
    // One grant lookup per viewer reads each note a few times; walking each note to the
    // root on its own read ~DEPTH²/2 notes per viewer.
    expect(rowsRead).toBeLessThan(2 * 20 * DEPTH);
  }, 120_000);

  it("stops at the first ancestor that is not direct", async () => {
    const author = (await signedInAccount("dcv-break-author@example.com")).id;
    const viewer = (await signedInAccount("dcv-break-viewer@example.com")).id;
    const ids = await chain("6dcb", [author], (index) => (index === 2 ? "private" : "direct"), 6);
    await mention(nth(ids, 0), viewer);
    await mention(nth(ids, 4), viewer);
    const shown = await viewableStatusIds(env.DB, await loaded(ids), [], viewer);
    // Note 2 is followers-only, so the mention on note 0 does not reach note 3 below it.
    expect([...shown].sort()).toEqual([0, 1, 4, 5].map((index) => nth(ids, index)));
  });

  it("ends a walk around a reply cycle", async () => {
    const author = (await signedInAccount("dcv-cycle-author@example.com")).id;
    const viewer = (await signedInAccount("dcv-cycle-viewer@example.com")).id;
    const ids = await chain("6dcc", [author], () => "direct", 3);
    await env.DB.prepare("UPDATE statuses SET in_reply_to_id = ? WHERE id = ?")
      .bind(nth(ids, 2), nth(ids, 0))
      .run();
    const statuses = await loaded(ids);
    expect([...(await viewableStatusIds(env.DB, statuses, [], viewer))]).toEqual([]);
    await mention(nth(ids, 1), viewer);
    expect([...(await viewableStatusIds(env.DB, statuses, [], viewer))].sort()).toEqual(ids);
  });
});
