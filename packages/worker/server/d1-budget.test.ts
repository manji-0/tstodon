import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { accessTokenFor, signedInAccount } from "../test/auth-fixture";
import {
  meter,
  meterWork,
  patchD1,
  requestsSettled,
  resetMeter,
  seedNoise,
  settle,
} from "../test/meter";
import { drainHeld, holdQueue, QUEUE_BATCH, QUEUE_INVOCATION_BUDGET } from "../test/queue-hold";
import { remoteActor } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { RemoteAccountId } from "./remote-account-id";
import { insertScheduledStatus } from "./scheduled-status-store";
import { HOME_HORIZON_STEPS, homeTimelineDocuments } from "./timeline-documents";
import { parseInstanceIdentity } from "./runtime-config";
import { ACTIVITY_JSON } from "../test/activity-json";

/**
 * D1 bills every row a query reads. A read endpoint whose rows read grows
 * with tables it does not show (a scan, a COUNT(*) over an author's history)
 * stays cheap in tests and costs the instance's quota in production. Each
 * endpoint here is measured before and after seeding rows it must not read;
 * its rows read may not grow by more than a page's worth.
 */

const NOISE = 3_000;
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
/** Allowed growth in rows read: well under the noise, well over a page. */
const MAX_GROWTH = 200;

const get = async (token: string, path: string): Promise<number> =>
  measure(path, () =>
    SELF.fetch(`https://example.com${path}`, {
      headers: { ...ACTIVITY_JSON.headers, Authorization: `Bearer ${token}` },
    }),
  );

/** The rows read by the request `send` makes, its after-response work included. */
const measure = async (path: string, send: () => Promise<Response>): Promise<number> => {
  await settle();
  resetMeter();
  const response = await send();
  expect(response.status, path).toBe(200);
  await response.text();
  await requestsSettled();
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

  it(
    "keeps home's rows read independent of how many posts carry a followed hashtag",
    { timeout: 120_000 },
    async () => {
      const [reader, noisy] = await Promise.all(
        ["budget-tag-reader", "budget-tag-noisy"].map((name) =>
          signedInAccount(`${name}@example.com`),
        ),
      );
      if (!reader || !noisy) throw new Error("accounts");
      const readerToken = await accessTokenFor(reader.id);
      if (!readerToken) throw new Error("token");
      await post(readerToken, "/api/v1/tags/budgetflood/follow");
      // The flood's authors are muted, so home shows the same page before and after it.
      await post(readerToken, `/api/v1/accounts/${noisy.id}/mute`);
      await env.DB.prepare(
        "INSERT INTO mutes (account_id, target_actor_uri) VALUES (?, 'https://flood.example/users/f')",
      )
        .bind(reader.id)
        .run();
      patchD1();
      const path = "/api/v1/timelines/home?limit=20";
      const before = await get(readerToken, path);
      const series = `WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < ${NOISE})`;
      await env.DB.batch([
        env.DB.prepare(
          `${series} INSERT INTO statuses (id, account_id, kind, content_text, content_html, visibility, sensitive, spoiler_text, created_at, updated_at)
           SELECT printf('flood%07d', n), ?, 'LocalNote', '#budgetflood', '<p>#budgetflood</p>', 'public', 0, '',
                  '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'
           FROM series`,
        ).bind(noisy.id),
        env.DB.prepare(
          `INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, fetched_at)
           VALUES ('https://flood.example/users/f', 'f', 'flood.example', 'https://flood.example/inbox',
                   '2020-01-01T00:00:00.000Z')`,
        ),
        env.DB.prepare(
          `${series} INSERT INTO remote_statuses (id, actor_uri, object_uri, content_html, visibility, published_at, created_at, updated_at, media_json, tags_indexed)
           SELECT printf('rflood%07d', n), 'https://flood.example/users/f', printf('https://flood.example/statuses/%d', n),
                  '<p>#budgetflood</p>', 'public', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', '[]', 1
           FROM series`,
        ),
        env.DB.prepare(
          "INSERT INTO local_status_tags (status_id, tag) SELECT id, 'budgetflood' FROM statuses WHERE id LIKE 'flood%'",
        ),
        env.DB.prepare(
          "INSERT INTO remote_status_tags (status_id, tag) SELECT id, 'budgetflood' FROM remote_statuses WHERE id LIKE 'rflood%'",
        ),
      ]);
      const growth = (await get(readerToken, path)) - before;
      // Each page reads a bounded depth of the hashtag's index, local and
      // remote, and a home left empty by the hidden flood reads past it
      // HOME_HORIZON_STEPS times: a fixed number of pages, not the flood.
      expect(growth, `home read ${growth} more rows after ${2 * NOISE} tagged posts`).toBeLessThan(
        MAX_GROWTH * 3 * HOME_HORIZON_STEPS,
      );
    },
  );

  it(
    "keeps home's rows read independent of the posts under many followed hashtags",
    { timeout: 120_000 },
    async () => {
      const [reader, noisy] = await Promise.all(
        ["budget-tags-reader", "budget-tags-noisy"].map((name) =>
          signedInAccount(`${name}@example.com`),
        ),
      );
      if (!reader || !noisy) throw new Error("accounts");
      const readerToken = await accessTokenFor(reader.id);
      if (!readerToken) throw new Error("token");
      const tags = 200;
      await env.DB.prepare(
        `WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < ${tags})
         INSERT INTO followed_tags (account_id, tag_name, created_at)
         SELECT ?, 'budgetmany' || n, '2020-01-01 00:00:00' FROM series`,
      )
        .bind(reader.id)
        .run();
      // The flood's author is muted, so each read answers the same empty page.
      await post(readerToken, `/api/v1/accounts/${noisy.id}/mute`);
      const flood = (from: number) => [
        env.DB.prepare(
          `WITH RECURSIVE series(n) AS (SELECT ${from} UNION ALL SELECT n + 1 FROM series WHERE n < ${from + NOISE - 1})
           INSERT INTO statuses (id, account_id, kind, content_text, content_html, visibility, sensitive, spoiler_text, created_at, updated_at)
           SELECT printf('%018d', 950000000000000000 + n), ?, 'LocalNote', '#budgetmany', '<p>#budgetmany</p>', 'public', 0, '',
                  '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'
           FROM series`,
        ).bind(noisy.id),
        env.DB.prepare(
          `INSERT OR IGNORE INTO local_status_tags (status_id, tag)
           SELECT id, 'budgetmany' || (1 + CAST(id AS INTEGER) % ${tags})
           FROM statuses WHERE account_id = ?`,
        ).bind(noisy.id),
      ];
      patchD1();
      const path = "/api/v1/timelines/home?limit=20";
      await env.DB.batch(flood(0));
      const before = await get(readerToken, path);
      await env.DB.batch(flood(NOISE));
      const growth = (await get(readerToken, path)) - before;
      // The followed hashtags' indexes are read together to a fixed depth, so
      // a page costs a few rows per hashtag and a fixed number of entries,
      // not a depth of each hashtag.
      expect(
        growth,
        `home read ${growth} more rows after ${NOISE} more posts under ${tags} followed hashtags`,
      ).toBeLessThan(MAX_GROWTH);
    },
  );

  it(
    "grows home's rows read by a few rows a followed hashtag, and a streamed entry's by none",
    { timeout: 120_000 },
    async () => {
      const followTags = async (accountId: string, count: number) =>
        env.DB.prepare(
          `WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < ${count})
           INSERT INTO followed_tags (account_id, tag_name, created_at)
           SELECT ?, 'budgetcount' || n, '2020-01-01 00:00:00' FROM series`,
        )
          .bind(accountId)
          .run();
      const [few, many] = await Promise.all(
        ["budget-count-few", "budget-count-many"].map((name) =>
          signedInAccount(`${name}@example.com`),
        ),
      );
      if (!few || !many) throw new Error("accounts");
      const added = 200;
      await followTags(few.id, 10);
      await followTags(many.id, 10 + added);
      const [fewToken, manyToken, authorToken] = await Promise.all(
        [few.id, many.id, (await signedInAccount("budget-count-author@example.com")).id].map((id) =>
          accessTokenFor(id),
        ),
      );
      if (!fewToken || !manyToken || !authorToken) throw new Error("tokens");
      const tagged = idOf(
        await post(authorToken, "/api/v1/statuses", { status: "under #budgetcount1" }),
      );
      patchD1();
      const path = "/api/v1/timelines/home?limit=20";
      // Each followed hashtag costs a row of the follows and an index seek or
      // two in each of the page's hashtag queries: the horizon, the remote
      // statuses, and the local statuses once per window a page this empty
      // reads (`FEED_PAGE_WINDOWS_MS`, three), about 17 rows.
      const perTag = ((await get(manyToken, path)) - (await get(fewToken, path))) / added;
      expect(perTag, `home read ${perTag} more rows per followed hashtag`).toBeLessThan(18);

      const identity = parseInstanceIdentity(env)._unsafeUnwrap();
      const streamed = async (viewerId: string): Promise<number> => {
        await settle();
        resetMeter();
        const page = await meterWork(() =>
          homeTimelineDocuments(env, identity, viewerId, 1, { onlyId: tagged }),
        );
        expect(page._unsafeUnwrap().statuses.map((status) => status.id)).toEqual([tagged]);
        return meter.tally.rowsRead;
      };
      const growth = (await streamed(many.id)) - (await streamed(few.id));
      expect(growth, `a streamed entry read ${growth} more rows`).toBeLessThan(MAX_GROWTH / 10);
    },
  );

  it(
    "keeps the ActivityPub collections' rows read independent of what they count",
    { timeout: 120_000 },
    async () => {
      const owner = await signedInAccount("budget-collections@example.com");
      if (!owner) throw new Error("account");
      const ownerToken = await accessTokenFor(owner.id);
      if (!ownerToken) throw new Error("token");
      const posted: string[] = [];
      for (let n = 0; n < 25; n += 1) {
        posted.push(idOf(await post(ownerToken, "/api/v1/statuses", { status: `collected ${n}` })));
      }
      const series = (from: number) =>
        `WITH RECURSIVE series(n) AS (SELECT ${from} UNION ALL SELECT n + 1 FROM series WHERE n < ${from + NOISE - 1})`;
      // Follows in both directions, newer than any noise, so the pages show them.
      const follows = (from: number) => [
        env.DB.prepare(
          `${series(from)} INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, fetched_at)
           SELECT 'https://many.example/users/u' || n, 'u' || n, 'many.example', 'https://many.example/inbox',
                  '2020-01-01T00:00:00.000Z'
           FROM series`,
        ),
        env.DB.prepare(
          `${series(from)} INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind)
           SELECT printf('9%017d', n), 'https://many.example/users/u' || n, ?, 'Fulfilled', 'Accepted' FROM series`,
        ).bind(owner.id),
        env.DB.prepare(
          `${series(from)} INSERT INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state)
           SELECT printf('9%017d', n), ?, 'https://many.example/users/u' || n,
                  'https://example.com/budget-follows/' || n, 'Accepted' FROM series`,
        ).bind(owner.id),
      ];
      const base = `/users/${owner.username}`;
      const paths = [
        `${base}/followers`,
        `${base}/followers?page=1`,
        `${base}/following`,
        `${base}/following?page=1`,
        `${base}/outbox`,
        `${base}/outbox?page=true`,
        `${base}/outbox?min_id=0&page=true`,
      ];
      // A signed outbox page also reads the statuses that mention its
      // signer; this one is mentioned nowhere.
      const signer = await remoteActor("budget-outbox-signer", "budget-signer.example");
      const signedPaths = [`${base}/outbox?page=true`, `${base}/outbox?min_id=0&page=true`];
      const signedGet = async (path: string) =>
        measure(path, async () => SELF.fetch(await signer.signedGet(path)));
      await env.DB.batch(follows(NOISE + 1));
      patchD1();
      const before = new Map<string, number>();
      for (const path of paths) {
        before.set(path, await get(ownerToken, path));
      }
      const signedBefore = new Map<string, number>();
      for (const path of signedPaths) {
        signedBefore.set(path, await signedGet(path));
      }
      // Older follows than every page's. Statuses an unsigned outbox page
      // must pass over, newer than its own: direct and followers-only notes
      // and followers-only boosts. And older public notes than any page shows.
      const statuses = (from: number, idFormat: string, kind: string, visibility: string) =>
        env.DB.prepare(
          `${series(from)} INSERT INTO statuses (id, account_id, kind, reblog_of_id, content_text, content_html, visibility, sensitive, spoiler_text, created_at, updated_at)
           SELECT printf('${idFormat}', n), ?, '${kind}', ${kind === "LocalReblog" ? "?" : "NULL"},
                  'noise', '<p>noise</p>', '${visibility}', 0, '',
                  '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'
           FROM series`,
        ).bind(owner.id, ...(kind === "LocalReblog" ? [posted[0] ?? ""] : []));
      await env.DB.batch([
        ...follows(1),
        statuses(1, "9%017d", "LocalNote", "direct"),
        statuses(NOISE + 1, "9%017d", "LocalNote", "private"),
        statuses(2 * NOISE + 1, "9%017d", "LocalReblog", "private"),
        statuses(1, "0%017d", "LocalNote", "public"),
      ]);
      for (const path of paths) {
        const rows = (await get(ownerToken, path)) - (before.get(path) ?? 0);
        expect(
          rows,
          `${path} read ${rows} more rows after ${NOISE} more follows and statuses of each kind`,
        ).toBeLessThan(MAX_GROWTH);
      }
      for (const path of signedPaths) {
        const rows = (await signedGet(path)) - (signedBefore.get(path) ?? 0);
        expect(
          rows,
          `signed ${path} read ${rows} more rows after ${NOISE} more statuses of each kind`,
        ).toBeLessThan(MAX_GROWTH);
      }
      const followers = await SELF.fetch(`https://example.com${base}/followers`, ACTIVITY_JSON);
      expect(await followers.json()).toMatchObject({ totalItems: 2 * NOISE });
      const outbox = await SELF.fetch(`https://example.com${base}/outbox`, ACTIVITY_JSON);
      // Direct statuses are not counted.
      expect(await outbox.json()).toMatchObject({ totalItems: 25 + 3 * NOISE });
    },
  );

  it(
    "keeps rendering remote accounts independent of how many domain blocks there are",
    { timeout: 120_000 },
    async () => {
      const reader = await signedInAccount("budget-blocks-reader@example.com");
      const token = await accessTokenFor(reader?.id);
      const actors = 40;
      const series = (n: number) =>
        `WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < ${n})`;
      await env.DB.prepare(
        `${series(actors)} INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, fetched_at)
         SELECT printf('https://open%d.budget-blocks.example/users/a', n), 'a',
                printf('open%d.budget-blocks.example', n), 'https://budget-blocks.example/inbox',
                '2026-11-01T00:00:00.000Z'
         FROM series`,
      ).run();
      const ids = Array.from({ length: actors }, (_, i) =>
        RemoteAccountId.encode(`https://open${i + 1}.budget-blocks.example/users/a`),
      );
      const path = `/api/v1/accounts?${ids.map((id) => `id[]=${encodeURIComponent(id)}`).join("&")}`;
      patchD1();
      const before = await get(token, path);
      await env.DB.prepare(
        `${series(NOISE)} INSERT INTO domain_blocks (id, domain, severity)
         SELECT printf('budget-block-%d', n), printf('blocked%d.example', n), 'suspend' FROM series`,
      ).run();
      try {
        const growth = (await get(token, path)) - before;
        // Each account's hosts seek the blocks by their parent domains' keys,
        // so the blocks on other domains are not read; joining each block to
        // the accounts' key ranges read about 4 × accounts × blocks rows.
        expect(
          growth,
          `${actors} accounts read ${growth} more rows after ${NOISE} blocks`,
        ).toBeLessThan(actors);
      } finally {
        await env.DB.prepare("DELETE FROM domain_blocks WHERE id LIKE 'budget-block-%'").run();
      }
    },
  );
});

/**
 * A request that names ids, accounts or actors runs a fixed number of D1
 * statements however many it names: one batched read for all of them, not
 * one per name, so a client or a remote server cannot buy thousands of
 * sequential queries with one request.
 */
describe("D1 statements do not grow with how many things a request names", () => {
  // The requests a test compares run at one instant, so an isolate cache that
  // expires by the clock (the stream listeners, 5 s) is read by all of them or
  // by none, not by whichever one starts after it expires.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The D1 statements, and the rows they read, of one request. */
  const metered = async (send: () => Promise<Response>) => {
    await settle();
    resetMeter();
    const response = await send();
    await response.text();
    await requestsSettled();
    return { status: response.status, ...meter.tally };
  };

  it(
    "counts only the request it measures, not a Workflow running beside it",
    { timeout: 60_000 },
    async () => {
      const account = await signedInAccount("budget-meter@example.com");
      const token = await accessTokenFor(account.id);
      if (!token) throw new Error("token");
      const request = () =>
        SELF.fetch("https://example.com/api/v1/accounts/verify_credentials", {
          headers: { Authorization: `Bearer ${token}` },
        });
      patchD1();
      await metered(request);
      const alone = await metered(request);
      // A delivery Workflow reads D1 in its own invocation, as one retrying
      // an earlier test's delivery does whenever its backoff ends.
      const beside = await metered(async () => {
        const instance = await env.OUTBOX_DELIVERY_WORKFLOW.create({
          params: { kind: "DeliverActivity", activityId: "budget-meter-no-such-activity" },
        });
        // About 30 s of settles; the clock is frozen, so it cannot time this.
        for (let tries = 0; (await instance.status()).status !== "complete"; tries += 1) {
          if (tries > 200) throw new Error("the Workflow did not complete");
          await settle();
        }
        return request();
      });
      expect([alone.status, beside.status]).toEqual([200, 200]);
      expect(alone.statements).toBeGreaterThan(0);
      expect(
        beside.statements,
        `the request alone made ${alone.statements} statements, beside a Workflow ${beside.statements}`,
      ).toBe(alone.statements);
    },
  );

  it(
    "reads the local actors an inbound note names in one query, however many it names",
    { timeout: 60_000 },
    async () => {
      const mentioned = await signedInAccount("budget-note-mentioned@example.com");
      const author = await remoteActor("budgetnoteauthor", "budget-notes.example");
      const local = `https://example.com/users/${mentioned.username}`;
      const unknown = (count: number, prefix: string) =>
        Array.from({ length: count }, (_, n) => `https://example.com/users/${prefix}${n}`);
      const deliver = async (name: string, count: number) => {
        const noteUri = `https://budget-notes.example/notes/${name}`;
        const activity = await author.delivery({
          id: `${noteUri}/create`,
          type: "Create",
          object: {
            id: noteUri,
            type: "Note",
            attributedTo: author.actorUri,
            content: "<p>hello</p>",
            published: new Date().toISOString(),
            to: [PUBLIC, ...unknown(count, `${name}to`)],
            cc: [local],
            tag: [local, ...unknown(count, `${name}tag`)].map((href) => ({
              type: "Mention",
              href,
            })),
          },
        });
        return metered(() => SELF.fetch(activity));
      };
      patchD1();
      // The first delivery from a sender also stores what later ones read back.
      await deliver("warm", 2);
      const few = await deliver("few", 2);
      const many = await deliver("many", 400);
      expect([few.status, many.status]).toEqual([202, 202]);
      expect(
        many.statements,
        `a note naming 800 unknown local actors made ${many.statements} statements, one naming 4 made ${few.statements}`,
      ).toBe(few.statements);
    },
  );

  it(
    "reads familiar followers for every requested account in a fixed number of queries",
    { timeout: 60_000 },
    async () => {
      const [viewer, friend, ...targets] = await Promise.all(
        Array.from({ length: 22 }, (_, n) => signedInAccount(`budget-fam-${n}@example.com`)),
      );
      if (!viewer || !friend) throw new Error("accounts");
      const [viewerToken, friendToken] = await Promise.all(
        [viewer, friend].map((account) => accessTokenFor(account.id)),
      );
      if (!viewerToken || !friendToken) throw new Error("tokens");
      await post(viewerToken, `/api/v1/accounts/${friend.id}/follow`);
      for (const target of targets) {
        await post(friendToken, `/api/v1/accounts/${target.id}/follow`);
      }
      const familiar = (count: number) =>
        metered(() =>
          SELF.fetch(
            `https://example.com/api/v1/accounts/familiar_followers?${targets
              .slice(0, count)
              .map((target) => `id[]=${target.id}`)
              .join("&")}`,
            { headers: { Authorization: `Bearer ${viewerToken}` } },
          ),
        );
      patchD1();
      await familiar(1);
      const one = await familiar(1);
      const twenty = await familiar(20);
      expect([one.status, twenty.status]).toEqual([200, 200]);
      expect(
        twenty.statements,
        `familiar followers of 20 accounts made ${twenty.statements} statements, of one ${one.statements}`,
      ).toBe(one.statements);
    },
  );

  it(
    "accepts and dismisses notification requests in a fixed number of queries",
    { timeout: 120_000 },
    async () => {
      const admin = await signedInAccount("budget-nr-admin@example.com", { admin: true });
      const adminToken = await accessTokenFor(admin.id);
      /** A recipient with `senders` held requests of `each` mentions; its token and their ids. */
      const held = async (name: string, senders: number, each: number) => {
        const recipient = await signedInAccount(`budget-nr-${name}@example.com`);
        for (let n = 0; n < senders; n += 1) {
          const sender = await signedInAccount(`budget-nr-${name}-sender-${n}@example.com`);
          await post(adminToken, `/api/v1/admin/accounts/${sender.id}/silence`);
          const senderToken = await accessTokenFor(sender.id);
          for (let m = 0; m < each; m += 1) {
            await post(senderToken, "/api/v1/statuses", {
              status: `@${recipient.username} held ${m}`,
            });
          }
        }
        const token = await accessTokenFor(recipient.id);
        const listed = await SELF.fetch("https://example.com/api/v1/notifications/requests", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const ids = z.array(z.object({ id: z.string() })).parse(await listed.json());
        expect(ids).toHaveLength(senders);
        return { token, ids: ids.map((request) => request.id) };
      };
      const send = (token: string, path: string, body?: unknown) =>
        metered(() =>
          SELF.fetch(`https://example.com${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(body ?? {}),
          }),
        );
      const [oneOne, fourByThree, acceptOne, acceptFour, singleOne, singleThree] =
        await Promise.all([
          held("d1", 1, 1),
          held("d4", 4, 3),
          held("a1", 1, 1),
          held("a4", 4, 3),
          held("s1", 1, 1),
          held("s3", 1, 3),
        ]);
      patchD1();
      const counts = {
        dismiss: [
          await send(oneOne.token, "/api/v1/notifications/requests/dismiss", { id: oneOne.ids }),
          await send(fourByThree.token, "/api/v1/notifications/requests/dismiss", {
            id: fourByThree.ids,
          }),
        ],
        accept: [
          await send(acceptOne.token, "/api/v1/notifications/requests/accept", {
            id: acceptOne.ids,
          }),
          await send(acceptFour.token, "/api/v1/notifications/requests/accept", {
            id: acceptFour.ids,
          }),
        ],
        single: [
          await send(singleOne.token, `/api/v1/notifications/requests/${singleOne.ids[0]}/dismiss`),
          await send(
            singleThree.token,
            `/api/v1/notifications/requests/${singleThree.ids[0]}/dismiss`,
          ),
        ],
      };
      for (const [action, [few, many]] of Object.entries(counts)) {
        expect([few?.status, many?.status], action).toEqual([200, 200]);
        expect(
          many?.statements,
          `${action}: ${many?.statements} statements for more requests or notifications, ${few?.statements} for one`,
        ).toBe(few?.statements);
      }
    },
  );

  it(
    "publishes a note in a fixed number of queries, however many followers it notifies",
    { timeout: 300_000 },
    async () => {
      /** An author followed with notifications on by `count` accounts, and its token. */
      const followed = async (name: string, count: number) => {
        const author = await signedInAccount(`budget-publish-${name}@example.com`);
        for (let start = 0; start < count; start += 10) {
          await Promise.all(
            Array.from({ length: Math.min(10, count - start) }, async (_, n) => {
              const follower = await signedInAccount(
                `budget-publish-${name}-${start + n}@example.com`,
              );
              await post(
                await accessTokenFor(follower.id),
                `/api/v1/accounts/${author.id}/follow`,
                {
                  notify: true,
                },
              );
            }),
          );
        }
        return accessTokenFor(author.id);
      };
      const publish = (token: string, status: string) =>
        metered(() =>
          SELF.fetch("https://example.com/api/v1/statuses", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ status }),
          }),
        );
      const [twoToken, manyToken] = [await followed("two", 2), await followed("many", 60)];
      patchD1();
      const queued = holdQueue();
      await publish(twoToken, "warm");
      await publish(manyToken, "warm");
      const two = await publish(twoToken, "for two");
      const many = await publish(manyToken, "for sixty");
      expect([two.status, many.status]).toEqual([200, 200]);
      expect(
        many.statements,
        `publishing for 60 notifying followers made ${many.statements} statements, for 2 ${two.statements}`,
      ).toBe(two.statements);

      const mostPerInvocation = await drainHeld(queued, ["NotifyLocalNoteFollowers"]);
      expect(
        mostPerInvocation,
        `one queue invocation of ${QUEUE_BATCH} jobs made ${mostPerInvocation} statements`,
      ).toBeLessThan(QUEUE_INVOCATION_BUDGET);
    },
  );

  it(
    "publishes a backlog of scheduled posts in queue runs that stay within budget",
    { timeout: 120_000 },
    async () => {
      const author = await signedInAccount("budget-scheduled@example.com");
      const backlog = 20;
      for (let n = 0; n < backlog; n += 1) {
        const stored = await insertScheduledStatus(env.DB, {
          accountId: author.id,
          scheduledAt: new Date(Date.now() - 60_000).toISOString(),
          params: {
            text: `scheduled ${n}`,
            visibility: "public",
            spoiler_text: "",
            sensitive: false,
            language: null,
            media_ids: [],
            media_attributes: [],
            poll: null,
            in_reply_to_id: null,
          },
        });
        expect(stored.isOk()).toBe(true);
      }
      patchD1();
      const queued = holdQueue();
      queued.bodies.push({ kind: "PublishScheduledStatuses" });

      const mostPerInvocation = await drainHeld(queued, ["PublishScheduledStatuses"]);

      expect(
        mostPerInvocation,
        `one queue invocation publishing scheduled posts made ${mostPerInvocation} statements`,
      ).toBeLessThan(QUEUE_INVOCATION_BUDGET);
      const [published] = parseRows(
        z.object({ n: z.number() }),
        (
          await env.DB.prepare("SELECT COUNT(*) AS n FROM statuses WHERE account_id = ?")
            .bind(author.id)
            .all()
        ).results,
      );
      expect(published?.n).toBe(backlog);
    },
  );

  it(
    "checks who may see a status's quotes in a fixed number of queries",
    { timeout: 60_000 },
    async () => {
      const [reader, author, quoter] = await Promise.all(
        ["budget-quotes-reader", "budget-quotes-author", "budget-quotes-quoter"].map((name) =>
          signedInAccount(`${name}@example.com`),
        ),
      );
      if (!reader || !author || !quoter) throw new Error("accounts");
      const [readerToken, authorToken, quoterToken] = await Promise.all(
        [reader, author, quoter].map((account) => accessTokenFor(account.id)),
      );
      if (!readerToken || !authorToken || !quoterToken) throw new Error("tokens");
      const quoted = async (count: number) => {
        const original = idOf(await post(authorToken, "/api/v1/statuses", { status: "quote me" }));
        for (let n = 0; n < count; n += 1) {
          await post(quoterToken, "/api/v1/statuses", {
            status: `quoting ${n}`,
            quoted_status_id: original,
          });
        }
        return original;
      };
      const [one, eight] = [await quoted(1), await quoted(8)];
      const quotes = (id: string) =>
        metered(() =>
          SELF.fetch(`https://example.com/api/v1/statuses/${id}/quotes`, {
            headers: { Authorization: `Bearer ${readerToken}` },
          }),
        );
      patchD1();
      await quotes(one);
      const few = await quotes(one);
      const many = await quotes(eight);
      expect([few.status, many.status]).toEqual([200, 200]);
      expect(
        many.statements,
        `listing 8 quotes made ${many.statements} statements, listing one ${few.statements}`,
      ).toBe(few.statements);
    },
  );

  // `REST::StatusSerializer#tagged_collections`: the tags, the collections
  // and the viewer's blocks are read once a page, not once a status.
  it(
    "renders a page of posts tagging collections in a fixed number of statements",
    { timeout: 60_000 },
    async () => {
      const [reader, owner, featured, one, eight] = await Promise.all(
        [
          "budget-tagged-reader",
          "budget-tagged-owner",
          "budget-tagged-featured",
          "budget-tagged-one",
          "budget-tagged-eight",
        ].map((name) => signedInAccount(`${name}@example.com`)),
      );
      if (!reader || !owner || !featured || !one || !eight) throw new Error("accounts");
      const [readerToken, ownerToken, oneToken, eightToken] = await Promise.all(
        [reader, owner, one, eight].map((account) => accessTokenFor(account.id)),
      );
      if (!readerToken || !ownerToken || !oneToken || !eightToken) throw new Error("tokens");
      const CollectionUrl = z.object({ collection: z.object({ url: z.string() }) });
      const urls: string[] = [];
      for (let n = 0; n < 8; n += 1) {
        const created = await post(ownerToken, "/api/v1/collections", {
          name: `Picks ${n}`,
          sensitive: false,
          discoverable: true,
          account_ids: [featured.id],
        });
        urls.push(CollectionUrl.parse(created).collection.url);
      }
      await post(oneToken, "/api/v1/statuses", { status: `see ${urls[0]}` });
      for (const url of urls) {
        await post(eightToken, "/api/v1/statuses", { status: `see ${url}` });
      }
      const statuses = (id: string) =>
        metered(() =>
          SELF.fetch(`https://example.com/api/v1/accounts/${id}/statuses?limit=8`, {
            headers: { Authorization: `Bearer ${readerToken}` },
          }),
        );
      const Tagged = z.array(z.object({ tagged_collections: z.array(z.unknown()) }));
      const shown = await SELF.fetch(
        `https://example.com/api/v1/accounts/${eight.id}/statuses?limit=8`,
        { headers: { Authorization: `Bearer ${readerToken}` } },
      );
      expect(
        Tagged.parse(await shown.json()).map((status) => status.tagged_collections.length),
      ).toEqual(Array.from({ length: 8 }, () => 1));
      patchD1();
      await statuses(one.id);
      await statuses(eight.id);
      const few = await statuses(one.id);
      const many = await statuses(eight.id);
      expect([few.status, many.status]).toEqual([200, 200]);
      expect(
        many.statements,
        `8 posts tagging 8 collections made ${many.statements} statements, one ${few.statements}`,
      ).toBe(few.statements);
    },
  );

  // A remote post's custom emoji are read when it is rendered, as Mastodon's
  // `CustomEmoji.from_text`: one statement a page, a key seek per emoji.
  it(
    "renders a page of remote posts with many custom emoji in a fixed number of statements",
    { timeout: 60_000 },
    async () => {
      const reader = await signedInAccount("budget-emoji-reader@example.com");
      const token = await accessTokenFor(reader.id);
      if (!token) throw new Error("token");
      const domain = "budget-emoji.example";
      const page = 20;
      /** An actor of `domain` with a page of posts, each writing `emojis` known emoji. */
      const author = async (name: string, emojis: number) => {
        const actorUri = `https://${domain}/users/${name}`;
        const shortcodes = (post: number) =>
          Array.from({ length: emojis }, (_, n) => `${name}_${post}_${n}`);
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, fetched_at)
             VALUES (?1, ?2, ?3, ?1 || '/inbox', '2020-01-01T00:00:00.000Z')`,
          ).bind(actorUri, name, domain),
          ...Array.from({ length: page }, (_, post) =>
            env.DB.prepare(
              `INSERT INTO remote_statuses (id, actor_uri, object_uri, content_html, visibility, published_at, created_at, updated_at, media_json)
               VALUES (?1, ?2, ?2 || '/statuses/' || ?1, ?3, 'public', '2020-01-01T00:00:00.000Z',
                 '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '[]')`,
            ).bind(
              `remoji${name}${String(post).padStart(3, "0")}`,
              actorUri,
              `<p>${shortcodes(post)
                .map((shortcode) => `:${shortcode}:`)
                .join(" ")}</p>`,
            ),
          ),
          env.DB.prepare(
            `INSERT INTO remote_custom_emojis (domain, shortcode, image_url, updated_at)
             SELECT ?1, value, 'https://' || ?1 || '/e/' || value || '.png', '2020-01-01T00:00:00.000Z'
             FROM json_each(?2)`,
          ).bind(
            domain,
            JSON.stringify(Array.from({ length: page }, (_, post) => shortcodes(post)).flat()),
          ),
        ]);
        return RemoteAccountId.encode(actorUri);
      };
      const [one, twenty] = [await author("one", 1), await author("twenty", 20)];
      const statuses = (id: string) =>
        metered(() =>
          SELF.fetch(`https://example.com/api/v1/accounts/${id}/statuses?limit=${page}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        );
      const Emojis = z.array(z.object({ emojis: z.array(z.unknown()) }));
      const shown = await SELF.fetch(
        `https://example.com/api/v1/accounts/${twenty}/statuses?limit=${page}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(Emojis.parse(await shown.json()).map((status) => status.emojis.length)).toEqual(
        Array.from({ length: page }, () => 20),
      );
      patchD1();
      await statuses(one);
      await statuses(twenty);
      const few = await statuses(one);
      const many = await statuses(twenty);
      expect([few.status, many.status]).toEqual([200, 200]);
      expect(
        many.statements,
        `a page writing 400 emoji made ${many.statements} statements, one writing 20 ${few.statements}`,
      ).toBe(few.statements);
      // A key seek per emoji the page writes: the primary key's entry, then the row.
      const extra = page * 20 - page;
      expect(many.rowsRead - few.rowsRead).toBe(2 * extra);

      await env.DB.prepare(
        `WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < ${NOISE})
         INSERT INTO remote_custom_emojis (domain, shortcode, image_url, updated_at)
         SELECT ?1, 'noise_' || n, 'https://' || ?1 || '/e/noise.png', '2020-01-01T00:00:00.000Z'
         FROM series`,
      )
        .bind(domain)
        .run();
      const growth = (await statuses(twenty)).rowsRead - many.rowsRead;
      expect(
        growth,
        `the page read ${growth} more rows after ${NOISE} more emoji of its domain`,
      ).toBeLessThan(MAX_GROWTH);
    },
  );
});
