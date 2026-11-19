import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { accessTokenFor, signedInAccount } from "../test/auth-fixture";
import { meter, patchD1, resetMeter, seedNoise, settle } from "../test/meter";
import { remoteActor } from "../test/remote-actor-fixture";
import { HOME_HORIZON_STEPS } from "./timeline-documents";
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

/** The rows read by the request `send` makes, after the writes before it settle. */
const measure = async (path: string, send: () => Promise<Response>): Promise<number> => {
  await settle();
  resetMeter();
  const response = await send();
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
      const posted: string[] = [];
      for (let n = 0; n < 25; n += 1) {
        posted.push(idOf(await post(ownerToken, "/api/v1/statuses", { status: `collected ${n}` })));
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
        const deadline = Date.now() + 30_000;
        while ((await instance.status()).status !== "complete") {
          if (Date.now() > deadline) throw new Error("the Workflow did not complete");
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
});
