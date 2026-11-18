import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { accessTokenFor, signedInAccount } from "../test/auth-fixture";
import { meter, patchD1, resetMeter, seedNoise, settle } from "../test/meter";
import { HOME_HORIZON_STEPS } from "./timeline-documents";

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

  it(
    "keeps the ActivityPub collections' rows read independent of what they count",
    { timeout: 120_000 },
    async () => {
      const owner = await signedInAccount("budget-collections@example.com");
      if (!owner) throw new Error("account");
      const ownerToken = await accessTokenFor(owner.id);
      if (!ownerToken) throw new Error("token");
      for (let n = 0; n < 25; n += 1) {
        await post(ownerToken, "/api/v1/statuses", { status: `collected ${n}` });
      }
      const series = (from: number) =>
        `WITH RECURSIVE series(n) AS (SELECT ${from} UNION ALL SELECT n + 1 FROM series WHERE n < ${from + NOISE - 1})`;
      // Follows in both directions, newer than any noise, so the pages show them.
      const follows = (from: number) => [
        env.DB.prepare(
          `${series(from)} INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, public_key_id, public_key_pem, fetched_at)
           SELECT 'https://many.example/users/u' || n, 'u' || n, 'many.example', 'https://many.example/inbox',
                  'https://many.example/users/u' || n || '#main-key', 'x', '2020-01-01T00:00:00.000Z'
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
      await env.DB.batch(follows(NOISE + 1));
      patchD1();
      const before = new Map<string, number>();
      for (const path of paths) {
        before.set(path, await get(ownerToken, path));
      }
      // Older follows than every page's, and statuses the outbox counts.
      await env.DB.batch([
        ...follows(1),
        env.DB.prepare(
          `${series(1)} INSERT INTO statuses (id, account_id, kind, content_text, content_html, visibility, sensitive, spoiler_text, created_at, updated_at)
           SELECT printf('collected%07d', n), ?, 'LocalNote', 'old', '<p>old</p>', 'public', 0, '',
                  '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'
           FROM series`,
        ).bind(owner.id),
      ]);
      for (const path of paths) {
        const rows = (await get(ownerToken, path)) - (before.get(path) ?? 0);
        expect(rows, `${path} read ${rows} more rows after ${NOISE} more follows`).toBeLessThan(
          MAX_GROWTH,
        );
      }
      const followers = await SELF.fetch(`https://example.com${base}/followers`);
      expect(await followers.json()).toMatchObject({ totalItems: 2 * NOISE });
      const outbox = await SELF.fetch(`https://example.com${base}/outbox`);
      expect(await outbox.json()).toMatchObject({ totalItems: 25 + NOISE });
    },
  );
});
