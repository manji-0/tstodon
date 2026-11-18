import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  ApActorCollection,
  ApActorCollectionPage,
  ApOutbox,
  ApOutboxPage,
} from "@tstodon/api/activitypub";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

/**
 * The followers, following and outbox collections, as Mastodon v4.7.5 serves
 * them: a root with the account's real count and a link to the first page,
 * pages of 12 follows or 20 statuses linked by `next` and `prev`, and the
 * follows hidden (the count kept) when the account hides its collections.
 * Mastodon reads a remote account's counts from these roots.
 */

const ORIGIN = "https://example.com";

const fetchJson = async (path: string, init?: RequestInit): Promise<unknown> => {
  const response = await SELF.fetch(new URL(path, ORIGIN), init);
  expect(response.status, path).toBe(200);
  return response.json();
};

const api = async (email: string, method: string, path: string, body?: unknown) => {
  const response = await SELF.fetch(new URL(path, ORIGIN), {
    method,
    headers: {
      ...(await authHeaders(email)),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, `${method} ${path}`).toBe(200);
  return response.json();
};

const Counts = z.object({
  statuses_count: z.number(),
  followers_count: z.number(),
  following_count: z.number(),
});

/**
 * `n` remote actors on `host` that follow `accountId` and that it follows,
 * as accepted follows with ids from `base` up (ids order the pages).
 */
const seedFollows = async (accountId: string, host: string, base: string, n: number) => {
  const series = `WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < ${n})`;
  await env.DB.batch([
    env.DB.prepare(
      `${series} INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, public_key_id, public_key_pem, fetched_at)
       SELECT 'https://' || ?1 || '/users/u' || n, 'u' || n, ?1, 'https://' || ?1 || '/inbox',
              'https://' || ?1 || '/users/u' || n || '#main-key', 'x', '2026-01-01T00:00:00.000Z'
       FROM series`,
    ).bind(host),
    env.DB.prepare(
      `${series} INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind)
       SELECT printf('%s%012d', ?2, n), 'https://' || ?1 || '/users/u' || n, ?3, 'Fulfilled', 'Accepted'
       FROM series`,
    ).bind(host, base, accountId),
    env.DB.prepare(
      `${series} INSERT INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state)
       SELECT printf('%s%012d', ?2, n), ?3, 'https://' || ?1 || '/users/u' || n,
              'https://example.com/follows/' || ?1 || n, 'Accepted'
       FROM series`,
    ).bind(host, base, accountId),
  ]);
  return Array.from({ length: n }, (_, i) => `https://${host}/users/u${i + 1}`);
};

/** Every page from `first` on, following `next`. */
const walk = async <Page extends { next?: string | undefined }>(
  first: string,
  read: (body: unknown) => Page,
  init?: () => Promise<RequestInit>,
): Promise<Page[]> => {
  const pages: Page[] = [];
  let next: string | undefined = first;
  while (next !== undefined) {
    expect(pages.length, "the walk ends").toBeLessThan(20);
    const page = read(await fetchJson(next, await init?.()));
    pages.push(page);
    next = page.next;
  }
  return pages;
};

describe("ActivityPub followers, following and outbox collections", () => {
  it(
    "counts every follow and status, and pages through each once",
    { timeout: 60_000 },
    async () => {
      const email = "collections-owner@example.com";
      const account = await signedInAccount(email);
      const actor = `${ORIGIN}/users/${account.username}`;
      const posted: string[] = [];
      for (let n = 0; n < 45; n += 1) {
        const visibility = n === 7 ? "private" : n === 8 ? "unlisted" : "public";
        const status = z
          .object({ id: z.string() })
          .parse(await api(email, "POST", "/api/v1/statuses", { status: `post ${n}`, visibility }));
        if (visibility !== "private") {
          posted.push(status.id);
        }
      }
      // Seeded after the posts, so that no delivery goes to these followers.
      const remotes = await seedFollows(account.id, "collections.example", "700000", 45);
      const counts = Counts.parse(await api(email, "GET", `/api/v1/accounts/${account.id}`));
      expect(counts).toEqual({ statuses_count: 45, followers_count: 45, following_count: 45 });

      for (const name of ["followers", "following"] as const) {
        const root = expectContract(
          ApActorCollection,
          await fetchJson(`/users/${account.username}/${name}`),
        );
        expect(root).toEqual({
          "@context": "https://www.w3.org/ns/activitystreams",
          id: `${actor}/${name}`,
          type: "OrderedCollection",
          totalItems: 45,
          first: `${actor}/${name}?page=1`,
        });
        const pages = await walk(root.first ?? "", (body) =>
          expectContract(ApActorCollectionPage, body),
        );
        expect(pages.map((page) => page.orderedItems.length)).toEqual([12, 12, 12, 9]);
        for (const page of pages) {
          expect(page).toMatchObject({ partOf: root.id, totalItems: 45 });
        }
        const items = pages.flatMap((page) => page.orderedItems);
        // Newest follow first, every follow once.
        expect(items).toEqual([...remotes].reverse());
        expect(pages[0]?.prev).toBeUndefined();
        // `prev` leads back to the page before.
        const back = expectContract(ApActorCollectionPage, await fetchJson(pages[1]?.prev ?? ""));
        expect(back.orderedItems).toEqual(pages[0]?.orderedItems);
      }

      const outbox = expectContract(ApOutbox, await fetchJson(`/users/${account.username}/outbox`));
      expect(outbox).toEqual({
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${actor}/outbox`,
        type: "OrderedCollection",
        totalItems: 45,
        first: `${actor}/outbox?page=true`,
        last: `${actor}/outbox?min_id=0&page=true`,
      });
      const pages = await walk(outbox.first, (body) => expectContract(ApOutboxPage, body));
      expect(pages.map((page) => page.orderedItems.length)).toEqual([20, 20, 4]);
      for (const page of pages) {
        expect(page.partOf).toBe(outbox.id);
        expect(page).not.toHaveProperty("totalItems");
      }
      const notes = pages.flatMap((page) =>
        page.orderedItems.map((item) =>
          item.type === "Create" ? item.object.id.split("/").at(-1) : undefined,
        ),
      );
      // Newest first; the followers-only post is not for an unsigned fetch.
      expect(notes).toEqual([...posted].reverse());
      const last = expectContract(ApOutboxPage, await fetchJson(outbox.last));
      expect(last.orderedItems).toEqual(pages.flatMap((page) => page.orderedItems).slice(-20));
    },
  );

  it("keeps the count and leaves out the pages of hidden collections", async () => {
    const email = "collections-hidden@example.com";
    const account = await signedInAccount(email);
    await seedFollows(account.id, "hidden-collections.example", "710000", 3);
    await api(email, "PATCH", "/api/v1/accounts/update_credentials", { hide_collections: true });
    const reader = await remoteActor("hidden-reader", "hidden-reader.example");

    for (const name of ["followers", "following"] as const) {
      const path = `/users/${account.username}/${name}`;
      expect(expectContract(ApActorCollection, await fetchJson(path))).toEqual({
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${ORIGIN}${path}`,
        type: "OrderedCollection",
        totalItems: 3,
      });
      expect((await SELF.fetch(new URL(`${path}?page=1`, ORIGIN))).status).toBe(403);
      expect((await reader.fetch(`${path}?page=1`)).status).toBe(403);
    }
    // The outbox is not one of the hidden collections.
    expect(
      expectContract(ApOutbox, await fetchJson(`/users/${account.username}/outbox`)).first,
    ).toBeDefined();
  });

  it("shows a signed follower the followers-only posts, and a blocked fetcher nothing", async () => {
    const email = "collections-signed@example.com";
    const account = await signedInAccount(email);
    const follower = await remoteActor("outbox-follower", "outbox-follower.example");
    const stranger = await remoteActor("outbox-stranger", "outbox-stranger.example");
    const blocked = await remoteActor("outbox-blocked", "outbox-blocked.example");
    expect(
      await follower.send({
        id: `${follower.actorUri}/follows/1`,
        type: "Follow",
        object: `${ORIGIN}/users/${account.username}`,
      }),
    ).toBe(202);
    const shared = z
      .object({ uri: z.string() })
      .parse(await api(email, "POST", "/api/v1/statuses", { status: "for everyone" }));
    const privateNote = z.object({ uri: z.string() }).parse(
      await api(email, "POST", "/api/v1/statuses", {
        status: "for followers",
        visibility: "private",
      }),
    );
    await api(email, "POST", `/api/v1/accounts/${RemoteAccountId.encode(blocked.actorUri)}/block`);

    const path = `/users/${account.username}/outbox?page=true`;
    const noteUris = async (response: Response): Promise<string[]> => {
      expect(response.status).toBe(200);
      return expectContract(ApOutboxPage, await response.json()).orderedItems.flatMap((item) =>
        item.type === "Create" ? [item.object.id] : [],
      );
    };
    expect(await noteUris(await follower.fetch(path))).toEqual([privateNote.uri, shared.uri]);
    expect(await noteUris(await stranger.fetch(path))).toEqual([shared.uri]);
    expect(await noteUris(await SELF.fetch(new URL(path, ORIGIN)))).toEqual([shared.uri]);
    expect(await noteUris(await blocked.fetch(path))).toEqual([]);
  });

  it("refuses the outbox of a suspended account, its followers included, as Mastodon", async () => {
    const email = "collections-suspended@example.com";
    const account = await signedInAccount(email);
    const follower = await remoteActor("outbox-suspended-follower", "outbox-suspended.example");
    expect(
      await follower.send({
        id: `${follower.actorUri}/follows/1`,
        type: "Follow",
        object: `${ORIGIN}/users/${account.username}`,
      }),
    ).toBe(202);
    await api(email, "POST", "/api/v1/statuses", {
      status: "for followers",
      visibility: "private",
    });
    await env.DB.prepare(
      "INSERT INTO account_moderation (account_id, moderation) VALUES (?, 'Suspended')",
    )
      .bind(account.id)
      .run();

    // Mastodon's `check_account_suspension`: 403, cached for 3 minutes.
    const base = `/users/${account.username}/outbox`;
    for (const response of [
      await SELF.fetch(new URL(base, ORIGIN)),
      await SELF.fetch(new URL(`${base}?page=true`, ORIGIN)),
      await follower.fetch(base),
      await follower.fetch(`${base}?page=true`),
    ]) {
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("max-age=180, public");
      expect(JSON.stringify(await response.json())).not.toContain("for followers");
    }
  });

  it("sends Mastodon's cache headers on the outbox", async () => {
    const email = "collections-cache@example.com";
    const account = await signedInAccount(email);
    await api(email, "POST", "/api/v1/statuses", { status: "cached" });
    const reader = await remoteActor("outbox-cache-reader", "outbox-cache.example");
    const headersOf = (response: Response) => ({
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      vary: response.headers.get("vary"),
    });
    const outbox = `/users/${account.username}/outbox`;
    expect(headersOf(await SELF.fetch(new URL(outbox, ORIGIN)))).toEqual({
      status: 200,
      cacheControl: "max-age=180, public",
      vary: null,
    });
    // A page differs by who signed for it, so each one varies by `Signature`.
    expect(headersOf(await SELF.fetch(new URL(`${outbox}?page=true`, ORIGIN)))).toEqual({
      status: 200,
      cacheControl: "max-age=60, public",
      vary: "Signature",
    });
    expect(headersOf(await reader.fetch(`${outbox}?page=true`))).toEqual({
      status: 200,
      cacheControl: "max-age=60, private",
      vary: "Signature",
    });
  });

  it("leaves direct statuses out of the statuses count, as Mastodon", async () => {
    const email = "collections-direct-count@example.com";
    const account = await signedInAccount(email);
    await api(email, "POST", "/api/v1/statuses", { status: "public" });
    await api(email, "POST", "/api/v1/statuses", { status: "followers", visibility: "private" });
    const direct = z
      .object({ id: z.string() })
      .parse(
        await api(email, "POST", "/api/v1/statuses", { status: "secret", visibility: "direct" }),
      );
    const counts = async () => ({
      rest: Counts.parse(await api(email, "GET", `/api/v1/accounts/${account.id}`)).statuses_count,
      ap: expectContract(ApOutbox, await fetchJson(`/users/${account.username}/outbox`)).totalItems,
    });
    expect(await counts()).toEqual({ rest: 2, ap: 2 });
    await api(email, "DELETE", `/api/v1/statuses/${direct.id}`);
    expect(await counts()).toEqual({ rest: 2, ap: 2 });
  });

  it("lists each status as it is now: deleted, edited and unboosted ones too", async () => {
    const email = "collections-current@example.com";
    const account = await signedInAccount(email);
    const follower = await remoteActor("outbox-current-follower", "outbox-current.example");
    const recipient = await remoteActor("outbox-current-dm", "outbox-current-dm.example");
    expect(
      await follower.send({
        id: `${follower.actorUri}/follows/1`,
        type: "Follow",
        object: `${ORIGIN}/users/${account.username}`,
      }),
    ).toBe(202);
    const Posted = z.object({ id: z.string(), uri: z.string() });
    const postAs = async (status: string, visibility: string) =>
      Posted.parse(await api(email, "POST", "/api/v1/statuses", { status, visibility }));
    const boosted = await postAs("boosted then not", "public");
    await api(email, "POST", `/api/v1/statuses/${boosted.id}/reblog`);
    await api(email, "POST", `/api/v1/statuses/${boosted.id}/unreblog`);
    const kept = await postAs("boosted", "public");
    await api(email, "POST", `/api/v1/statuses/${kept.id}/reblog`);
    const edited = await postAs("first version", "public");
    await api(email, "PUT", `/api/v1/statuses/${edited.id}`, { status: "second version" });
    const gonePrivate = await postAs("followers only, then deleted", "private");
    const goneDirect = await postAs(
      "@outbox-current-dm@outbox-current-dm.example a direct note, then deleted",
      "direct",
    );
    const keptDirect = await postAs(
      "@outbox-current-dm@outbox-current-dm.example a direct note",
      "direct",
    );
    await api(email, "DELETE", `/api/v1/statuses/${gonePrivate.id}`);
    await api(email, "DELETE", `/api/v1/statuses/${goneDirect.id}`);

    const path = `/users/${account.username}/outbox?page=true`;
    const page = async (response: Response) => {
      expect(response.status).toBe(200);
      return expectContract(ApOutboxPage, await response.json()).orderedItems;
    };
    const summary = (items: Awaited<ReturnType<typeof page>>) =>
      items.map((item) =>
        item.type === "Create"
          ? {
              type: item.type,
              id: item.object.id,
              content: "content" in item.object ? item.object.content : undefined,
            }
          : { type: item.type, id: item.object },
      );
    const contentOf = (text: string) => expect.stringContaining(text);
    expect(summary(await page(await follower.fetch(path)))).toEqual([
      { type: "Create", id: edited.uri, content: contentOf("second version") },
      { type: "Announce", id: kept.uri },
      { type: "Create", id: kept.uri, content: contentOf("boosted") },
      { type: "Create", id: boosted.uri, content: contentOf("boosted then not") },
    ]);
    expect(summary(await page(await recipient.fetch(path)))).toEqual([
      { type: "Create", id: keptDirect.uri, content: contentOf("a direct note") },
      { type: "Create", id: edited.uri, content: contentOf("second version") },
      { type: "Announce", id: kept.uri },
      { type: "Create", id: kept.uri, content: contentOf("boosted") },
      { type: "Create", id: boosted.uri, content: contentOf("boosted then not") },
    ]);
  });
});
