import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { signedInAccount } from "../test/auth-fixture";
import {
  listRemoteStatusRetentionSlice,
  pruneRemoteStatusRetentionSlice,
  pruneUnreferencedRemoteActors,
} from "./generated/prisma/sql";
import {
  pruneStaleRemoteStatuses,
  REMOTE_STATUS_RETENTION_SLICE,
  type RemoteStatusRetentionPass,
} from "./remote-status-retention";
import { handleScheduled } from "./scheduled-handler";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A clock in 2001: ids and timestamps the fixtures write today sort after its cutoff. */
const NOW = Date.parse("2001-06-01T00:00:00.000Z");
const OLD = "2001-01-01T00:00:00.000Z";
const RECENT = new Date(NOW - DAY_MS).toISOString();

/** An 18-digit id from 2000, under the 2001 cutoff's, ordered by `n`. */
const oldId = (n: number): string => `0600000000${String(n).padStart(8, "0")}`;

const LOCAL_PREFIX = "https://example.com/users/";

const withVars = (vars: Readonly<Record<string, string>>): Env =>
  new Proxy(env, {
    get: (target, key) =>
      typeof key === "string" && key in vars ? vars[key] : Reflect.get(target, key),
  });

const insertActor = (uri: string, createdAt: string = OLD) =>
  env.DB.prepare(
    `INSERT INTO remote_actors
       (actor_uri, username, domain, inbox_uri, public_key_id, public_key_pem, fetched_at, created_at)
     VALUES (?, 'u', 'remote.example', ?, ?, 'pem', ?, ?)`,
  ).bind(uri, `${uri}/inbox`, `${uri}#key`, createdAt, createdAt);

type SeedStatus = Readonly<{
  id: string;
  actor: string;
  visibility?: string;
  updatedAt?: string;
  inReplyTo?: string;
}>;

const objectUri = (id: string): string => `https://remote.example/statuses/${id}`;

const insertStatus = ({
  id,
  actor,
  visibility = "public",
  updatedAt = OLD,
  inReplyTo,
}: SeedStatus) =>
  env.DB.prepare(
    `INSERT INTO remote_statuses
       (id, actor_uri, object_uri, content_html, visibility, published_at, created_at, updated_at, in_reply_to_uri)
     VALUES (?, ?, ?, '<p>x</p>', ?, ?, ?, ?, ?)`,
  ).bind(id, actor, objectUri(id), visibility, OLD, OLD, updatedAt, inReplyTo ?? null);

const column = async (sql: string, ...binds: ReadonlyArray<string>): Promise<string[]> => {
  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all();
  return z
    .array(z.object({ v: z.string() }))
    .parse(results)
    .map((row) => row.v);
};

const cursor = async (): Promise<string> =>
  (
    await column(
      "SELECT after_id AS v FROM backfill_cursors WHERE name = 'remote_status_retention'",
    )
  )[0] ?? "missing";

const pass = async (
  limit: number,
  vars: Readonly<Record<string, string>> = {},
): Promise<RemoteStatusRetentionPass | undefined> =>
  (await pruneStaleRemoteStatuses(withVars(vars), NOW, limit))._unsafeUnwrap();

/** D1's billed rows for every statement `work` runs, read from each result's `meta`. */
const meterD1 = async <T>(
  work: () => Promise<T>,
): Promise<{ value: T; rowsRead: number; rowsWritten: number }> => {
  const stmtProto: object = Object.getPrototypeOf(env.DB.prepare("SELECT 1"));
  const dbProto: object = Object.getPrototypeOf(env.DB);
  const totals = { rowsRead: 0, rowsWritten: 0 };
  const count = (result: unknown): void => {
    const meta: unknown =
      typeof result === "object" && result !== null ? Reflect.get(result, "meta") : undefined;
    const parsed = z.object({ rows_read: z.number(), rows_written: z.number() }).safeParse(meta);
    if (parsed.success) {
      totals.rowsRead += parsed.data.rows_read;
      totals.rowsWritten += parsed.data.rows_written;
    }
  };
  const originals = [
    [stmtProto, "all"],
    [stmtProto, "run"],
    [dbProto, "batch"],
  ] as const;
  const saved = originals.map(
    ([proto, method]) => [proto, method, Reflect.get(proto, method)] as const,
  );
  for (const [proto, method, original] of saved) {
    Reflect.set(proto, method, async function (this: unknown, ...args: unknown[]) {
      const result: unknown = await Reflect.apply(original, this, args);
      if (Array.isArray(result)) {
        result.forEach(count);
      } else {
        count(result);
      }
      return result;
    });
  }
  try {
    const value = await work();
    return { value, ...totals };
  } finally {
    for (const [proto, method, original] of saved) {
      Reflect.set(proto, method, original);
    }
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("remote status retention", () => {
  it("deletes exactly the stale remote statuses and actors nothing local needs", async () => {
    const local = await signedInAccount("retention-owner@example.com");
    const localStatusUri = `${LOCAL_PREFIX}${local.username}/statuses/1`;
    const followed = "https://remote.example/users/followed";
    const follower = "https://remote.example/users/follower";
    const reported = "https://remote.example/users/reported";
    const stranger = "https://remote.example/users/stranger";
    const loner = "https://remote.example/users/loner";
    const blocked = "https://remote.example/users/blocked";
    const newcomer = "https://remote.example/users/newcomer";
    let n = 0;
    const next = () => oldId((n += 1));
    const ids = {
      plain1: next(),
      fav: next(),
      bookmark: next(),
      plain2: next(),
      localBoost: next(),
      localReply: next(),
      replyToLocal: next(),
      grandchildOfLocal: next(),
      parentOfFollowed: next(),
      quoted: next(),
      quotesLocal: next(),
      voted: next(),
      mentionsLocal: next(),
      threadMuted: next(),
      boostedByFollowed: next(),
      boostedByStranger: next(),
      direct: next(),
      fresh: next(),
      staleParent: next(),
      staleChild: next(),
      plain3: next(),
      byFollowed: next(),
      byFollower: next(),
      byReported: next(),
      byLoner: next(),
      byBlocked: next(),
      byNewcomer: next(),
    };
    await env.DB.batch([
      ...[followed, follower, reported, stranger, loner, blocked].map((uri) => insertActor(uri)),
      insertActor(newcomer, RECENT),
      ...[
        ids.plain1,
        ids.fav,
        ids.bookmark,
        ids.plain2,
        ids.localBoost,
        ids.localReply,
        ids.parentOfFollowed,
        ids.quoted,
        ids.quotesLocal,
        ids.voted,
        ids.mentionsLocal,
        ids.threadMuted,
        ids.boostedByFollowed,
        ids.boostedByStranger,
        ids.staleParent,
        ids.plain3,
      ].map((id) => insertStatus({ id, actor: stranger })),
      insertStatus({ id: ids.replyToLocal, actor: stranger, inReplyTo: localStatusUri }),
      insertStatus({
        id: ids.grandchildOfLocal,
        actor: stranger,
        inReplyTo: objectUri(ids.replyToLocal),
      }),
      insertStatus({ id: ids.direct, actor: stranger, visibility: "direct" }),
      insertStatus({ id: ids.fresh, actor: stranger, updatedAt: RECENT }),
      insertStatus({ id: ids.staleChild, actor: stranger, inReplyTo: objectUri(ids.staleParent) }),
      insertStatus({
        id: ids.byFollowed,
        actor: followed,
        inReplyTo: objectUri(ids.parentOfFollowed),
      }),
      insertStatus({ id: ids.byFollower, actor: follower }),
      insertStatus({ id: ids.byReported, actor: reported }),
      insertStatus({ id: ids.byLoner, actor: loner }),
      insertStatus({ id: ids.byBlocked, actor: blocked }),
      insertStatus({ id: ids.byNewcomer, actor: newcomer }),
      env.DB.prepare(
        "INSERT INTO remote_status_tags (status_id, tag) VALUES (?, 'stale'), (?, 'kept')",
      ).bind(ids.plain1, ids.fav),
      env.DB.prepare(
        `INSERT INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state)
         VALUES ('ret-of', ?, ?, 'https://example.com/follows/ret', 'Accepted')`,
      ).bind(local.id, followed),
      env.DB.prepare(
        `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind)
         VALUES ('ret-rf', ?, ?, 'Accepted', 'Follow')`,
      ).bind(follower, local.id),
      env.DB.prepare(
        "INSERT INTO reports (id, account_id, target_actor_uri) VALUES ('ret-report', ?, ?)",
      ).bind(local.id, reported),
      env.DB.prepare(
        "INSERT INTO favourites (id, account_id, remote_status_id) VALUES ('ret-fav', ?, ?)",
      ).bind(local.id, ids.fav),
      env.DB.prepare(
        "INSERT INTO bookmarks (id, account_id, remote_status_id) VALUES ('ret-bm', ?, ?)",
      ).bind(local.id, ids.bookmark),
      env.DB.prepare(
        `INSERT INTO statuses (id, account_id, kind, visibility, reblog_of_remote_id)
         VALUES ('ret-local-boost', ?, 'LocalReblog', 'public', ?)`,
      ).bind(local.id, ids.localBoost),
      env.DB.prepare(
        `INSERT INTO statuses (id, account_id, kind, visibility, in_reply_to_uri)
         VALUES ('ret-local-reply', ?, 'LocalNote', 'public', ?)`,
      ).bind(local.id, objectUri(ids.localReply)),
      env.DB.prepare(
        `INSERT INTO status_quotes (id, status_id, quoted_remote_status_id, state, created_at, updated_at)
         VALUES ('ret-q1', 'ret-local-reply', ?, 'accepted', ?, ?)`,
      ).bind(ids.quoted, OLD, OLD),
      env.DB.prepare(
        `INSERT INTO status_quotes (id, remote_status_id, quoted_status_id, state, created_at, updated_at)
         VALUES ('ret-q2', ?, 'ret-local-reply', 'accepted', ?, ?)`,
      ).bind(ids.quotesLocal, OLD, OLD),
      env.DB.prepare(
        `INSERT INTO remote_poll_own_votes (status_id, account_id, choice_index, activity_id)
         VALUES (?, ?, 0, 'https://example.com/votes/ret')`,
      ).bind(ids.voted, local.id),
      env.DB.prepare(
        "INSERT INTO remote_status_mentions (status_id, account_id) VALUES (?, ?)",
      ).bind(ids.mentionsLocal, local.id),
      env.DB.prepare(
        "INSERT INTO status_mutes (account_id, thread_root_status_id) VALUES (?, ?)",
      ).bind(local.id, ids.threadMuted),
      env.DB.prepare(
        `INSERT INTO remote_boosts (id, actor_uri, activity_id, remote_status_id, visibility, published_at)
         VALUES ('ret-b1', ?, 'https://remote.example/boosts/1', ?, 'public', ?),
                ('ret-b2', ?, 'https://remote.example/boosts/2', ?, 'public', ?)`,
      ).bind(followed, ids.boostedByFollowed, OLD, loner, ids.boostedByStranger, OLD),
      env.DB.prepare(
        "INSERT INTO blocks (id, blocker_account_id, target_actor_uri) VALUES ('ret-block', ?, ?)",
      ).bind(local.id, blocked),
    ]);

    // A slice of 4 over 27 statuses: seven passes, the last short, so it wraps.
    const passes: RemoteStatusRetentionPass[] = [];
    for (;;) {
      const done = await pass(4);
      if (done === undefined) throw new Error("retention did not run");
      passes.push(done);
      if (done.wrapped) break;
      expect(await cursor()).not.toBe("");
    }
    expect(passes.map((p) => p.examined)).toEqual([4, 4, 4, 4, 4, 4, 3]);
    expect(await cursor()).toBe("");
    // The stale parent kept by its stale reply goes on the next cycle.
    let second = await pass(100);
    expect(second).toMatchObject({ examined: 27 - passes.reduce((s, p) => s + p.statuses, 0) });
    expect(second?.statuses).toBe(1);
    expect(second?.wrapped).toBe(true);
    second = await pass(100);
    expect(second?.statuses).toBe(0);

    const deleted = [
      ids.plain1,
      ids.plain2,
      ids.plain3,
      ids.boostedByStranger,
      ids.staleParent,
      ids.staleChild,
      ids.byLoner,
      ids.byBlocked,
      ids.byNewcomer,
    ];
    const kept = Object.values(ids).filter((id) => !deleted.includes(id));
    expect(
      await column("SELECT id AS v FROM remote_statuses WHERE id LIKE '0600%' ORDER BY id"),
    ).toEqual(kept.toSorted());
    // Cascades: the stale status's tag and the stranger's boost of one.
    expect(
      await column("SELECT status_id AS v FROM remote_status_tags WHERE tag IN ('stale', 'kept')"),
    ).toEqual([ids.fav]);
    expect(
      await column("SELECT id AS v FROM remote_boosts WHERE id LIKE 'ret-%' ORDER BY id"),
    ).toEqual(["ret-b1"]);
    // The loner had only a stale status; the blocked actor and the one cached
    // a day ago stay. The loner boosted a status, but that boost went with it.
    expect(
      await column(
        "SELECT actor_uri AS v FROM remote_actors WHERE actor_uri LIKE 'https://remote.example/users/%' ORDER BY actor_uri",
      ),
    ).toEqual([blocked, followed, follower, newcomer, reported, stranger].toSorted());
  });

  it("reads nothing and writes nothing when retention is off", async () => {
    const metered = await meterD1(() => pass(10, { REMOTE_STATUS_RETENTION_DAYS: "off" }));
    expect(metered).toEqual({ value: undefined, rowsRead: 0, rowsWritten: 0 });
  });

  it("walks each slice and every probe through an index", async () => {
    const plan = async (typed: {
      sql: string;
      values: ReadonlyArray<unknown>;
    }): Promise<string[]> => {
      const sql = typed.sql.replace(/\$(\d+)/g, "?$1");
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...typed.values)
        .all();
      return z
        .array(z.object({ detail: z.string() }))
        .parse(results)
        .map((row) => row.detail);
    };
    const scans = (lines: ReadonlyArray<string>) =>
      lines.filter((line) => line.startsWith("SCAN") && !line.startsWith("SCAN json_each"));
    const slice = await plan(listRemoteStatusRetentionSlice("", oldId(1), 1000));
    expect(slice).toEqual([
      "SEARCH remote_statuses USING INDEX sqlite_autoindex_remote_statuses_1 (id>? AND id<?)",
    ]);
    const statuses = await plan(pruneRemoteStatusRetentionSlice("", oldId(1), OLD, LOCAL_PREFIX));
    expect(scans(statuses)).toEqual([]);
    // The delete's own range and 17 probes, then one seek per table its
    // foreign keys cascade to.
    expect(statuses.filter((line) => line.startsWith("SEARCH"))).toHaveLength(29);
    for (const child of [
      "remote_status_tags",
      "remote_status_edits",
      "remote_status_mentions",
      "remote_status_remote_mentions",
      "remote_actor_pins",
      "remote_boosts",
      "status_quotes",
      "favourites",
      "bookmarks",
      "remote_poll_own_votes",
      "statuses",
    ]) {
      expect(statuses.some((line) => line.startsWith(`SEARCH ${child} USING`))).toBe(true);
    }
    expect(statuses).toContain(
      "SEARCH f USING COVERING INDEX idx_outbound_follows_actor_id (actor_uri=?)",
    );
    const actors = await plan(pruneUnreferencedRemoteActors("[]", OLD));
    expect(scans(actors)).toEqual([]);
    // The candidates, 16 probes, and one seek per table its foreign keys
    // cascade to (8).
    expect(actors.filter((line) => line.startsWith("SEARCH"))).toHaveLength(25);
  });

  it("bills rows by the slice, not the table", async () => {
    const local = await signedInAccount("retention-bench@example.com");
    const followed = "https://bench.example/users/followed";
    const stranger = "https://bench.example/users/stranger";
    await env.DB.batch([
      insertActor(followed),
      insertActor(stranger),
      env.DB.prepare(
        `INSERT INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state)
         VALUES ('bench-of', ?, ?, 'https://example.com/follows/bench', 'Accepted')`,
      ).bind(local.id, followed),
      // Start past the first test's statuses, at this test's.
      env.DB.prepare(
        "UPDATE backfill_cursors SET after_id = '060999999999999999' WHERE name = 'remote_status_retention'",
      ),
    ]);
    // 20,000 statuses: odd ones by a followed author (kept), even ones by a
    // stranger with a tag (deleted, with the tag).
    const total = 20_000;
    await env.DB.prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?1)
       INSERT INTO remote_statuses
         (id, actor_uri, object_uri, content_html, visibility, published_at, created_at, updated_at)
       SELECT '0610000000' || printf('%08d', n), CASE n % 2 WHEN 1 THEN ?2 ELSE ?3 END,
              'https://bench.example/statuses/' || n, '<p>x</p>', 'public', ?4, ?4, ?4
       FROM seq`,
    )
      .bind(total, followed, stranger, OLD)
      .run();
    await env.DB.prepare(
      `INSERT INTO remote_status_tags (status_id, tag)
       SELECT id, 'bench' FROM remote_statuses WHERE actor_uri = ? AND id LIKE '0610%'`,
    )
      .bind(stranger)
      .run();
    const before = await column(
      "SELECT count(*) || '' AS v FROM remote_statuses WHERE id LIKE '0610%'",
    );
    expect(before).toEqual([String(total)]);

    const slice = REMOTE_STATUS_RETENTION_SLICE;
    const first = await meterD1(() => pass(slice));
    const second = await meterD1(() => pass(slice));
    expect(first.value).toMatchObject({ examined: slice, statuses: slice / 2, wrapped: false });
    expect(second.value).toMatchObject({ examined: slice, statuses: slice / 2, wrapped: false });
    console.log(
      `RETENTION_ROWS slice=${slice} table=${total} ` +
        `first_read=${first.rowsRead} first_written=${first.rowsWritten} ` +
        `second_read=${second.rowsRead} second_written=${second.rowsWritten}`,
    );
    // Bounded by the slice, whatever the table holds: the slice's ids, then
    // the delete's range, its probes and cascades (about 1000 + 5000 here).
    expect(first.rowsRead).toBeLessThan(slice * 7);
    expect(second.rowsRead).toBe(first.rowsRead);
    expect(first.rowsWritten).toBeLessThanOrEqual(slice + 1);
  });

  it("runs a slice from the hourly cron", async () => {
    vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "send").mockResolvedValue({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    const log = vi.spyOn(console, "log");
    const ctx = createExecutionContext();
    await handleScheduled(
      { cron: "17 * * * *", scheduledTime: Date.now(), noRetry: () => undefined },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(
      log.mock.calls.some(
        ([line]) => typeof line === "string" && line.includes('"kind":"RemoteStatusRetentionPass"'),
      ),
    ).toBe(true);
  });
});
