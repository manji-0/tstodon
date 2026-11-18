import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { accessTokenFor, signedInAccount } from "../test/auth-fixture";
import { meter, patchD1, resetMeter, seedNoise, settle } from "../test/meter";
import { remoteActor } from "../test/remote-actor-fixture";
import { HOME_HORIZON_STEPS } from "./timeline-documents";

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
          `INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, public_key_id, public_key_pem, fetched_at)
           VALUES ('https://flood.example/users/f', 'f', 'flood.example', 'https://flood.example/inbox',
                   'https://flood.example/users/f#main-key', 'x', '2020-01-01T00:00:00.000Z')`,
        ),
        env.DB.prepare(
          `${series} INSERT INTO remote_statuses (id, actor_uri, object_uri, content_html, visibility, published_at, created_at, updated_at, media_json, tags_indexed, emojis_json)
           SELECT printf('rflood%07d', n), 'https://flood.example/users/f', printf('https://flood.example/statuses/%d', n),
                  '<p>#budgetflood</p>', 'public', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', '[]', 1, '[]'
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
});

/**
 * A request that names ids, accounts or actors runs a fixed number of D1
 * statements however many it names: one batched read for all of them, not
 * one per name, so a client or a remote server cannot buy thousands of
 * sequential queries with one request.
 */
describe("D1 statements do not grow with how many things a request names", () => {
  /** The D1 statements, and the rows they read, of one request. */
  const metered = async (send: () => Promise<Response>) => {
    await settle();
    resetMeter();
    const response = await send();
    await response.text();
    await settle();
    return { status: response.status, ...meter.tally };
  };

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
});
