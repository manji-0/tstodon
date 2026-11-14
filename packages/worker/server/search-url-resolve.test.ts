import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import type { z } from "zod";
import { ApiSearchResults, ApiStatus } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`response schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const search = async (email: string, params: Record<string, string>) => {
  const response = await SELF.fetch(
    `https://example.com/api/v2/search?${new URLSearchParams(params).toString()}`,
    { headers: await authHeaders(email) },
  );
  return { status: response.status, body: await response.json() };
};

const post = async (email: string, status: string, visibility: string = "public") => {
  const response = await SELF.fetch("https://example.com/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status, visibility }),
  });
  expect(response.status).toBe(200);
  return read(ApiStatus, await response.json());
};

/** Serve `documents` by URL to the Worker's outbound fetches for the duration of `run`. */
const withRemoteDocuments = async (
  documents: Readonly<Record<string, unknown>>,
  run: (fetched: string[]) => Promise<void>,
): Promise<void> => {
  const original = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const document = documents[href];
    if (document === undefined) {
      return original(input, init);
    }
    fetched.push(href);
    return new Response(JSON.stringify(document), {
      headers: { "content-type": "application/activity+json" },
    });
  };
  try {
    await run(fetched);
  } finally {
    globalThis.fetch = original;
  }
};

describe("search with a long query", () => {
  it("answers 200 for a 200-byte q, for every result type", async () => {
    const viewer = "search-long-viewer@example.com";
    const q = "longsearchq ".repeat(17).slice(0, 200);
    expect(new TextEncoder().encode(q).length).toBe(200);
    for (const type of ["accounts", "statuses", "hashtags", ""]) {
      const found = await search(viewer, type.length > 0 ? { q, type } : { q });
      expect(found.status, `type=${type}`).toBe(200);
      read(ApiSearchResults, found.body);
    }
  });

  it("finds a status by a phrase longer than 48 bytes", async () => {
    const author = "search-long-author@example.com";
    const phrase = "a phrase that is well past the forty-eight bytes a LIKE pattern may hold";
    const status = await post(author, `before ${phrase} after`);
    const found = await search(author, { q: phrase.toUpperCase(), type: "statuses" });
    expect(found.status).toBe(200);
    expect(read(ApiSearchResults, found.body).statuses.map((entry) => entry.id)).toEqual([
      status.id,
    ]);
  });

  it("matches % and _ as themselves, not as wildcards", async () => {
    const author = "search-literal-author@example.com";
    await post(author, "literalsearchq plain words only");
    const percent = await post(author, "literalsearchq 100% sure");
    const underscore = await post(author, "literalsearchq snake_case");
    const ids = async (q: string) =>
      read(ApiSearchResults, (await search(author, { q, type: "statuses" })).body).statuses.map(
        (entry) => entry.id,
      );
    expect(await ids("literalsearchq 100%")).toEqual([percent.id]);
    expect(await ids("snake_case")).toEqual([underscore.id]);
    expect(await ids("literalsearchq p_ain")).toEqual([]);
  });
});

describe("search for a post URL with resolve=true", () => {
  it("fetches a remote post it has never seen and returns it", async () => {
    const viewer = "search-url-viewer@example.com";
    const author = await remoteActor("searchurlauthor", "mastodon-url.example");
    // As long as a Mastodon 4.7 post URI.
    const noteUri =
      "https://mastodon-url.example/ap/users/117616253329183599/statuses/117616254442416194";
    const note = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: noteUri,
      type: "Note",
      attributedTo: author.actorUri,
      content: "<p>found by its URL</p>",
      published: "2026-11-14T00:00:00.000Z",
      to: [PUBLIC],
      cc: [],
    };
    await withRemoteDocuments({ [noteUri]: note }, async (fetched) => {
      const found = await search(viewer, { q: noteUri, resolve: "true", type: "statuses" });
      expect(found.status).toBe(200);
      const statuses = read(ApiSearchResults, found.body).statuses;
      expect(statuses.map((status) => status.uri)).toEqual([noteUri]);
      expect(statuses[0]?.content).toContain("found by its URL");
      expect(fetched).toEqual([noteUri]);

      // Cached now: the same search reads it back without a fetch.
      const again = await search(viewer, { q: noteUri, resolve: "true" });
      expect(read(ApiSearchResults, again.body).statuses.map((status) => status.uri)).toEqual([
        noteUri,
      ]);
      expect(fetched).toEqual([noteUri]);
    });
  });

  it("does not fetch without resolve=true", async () => {
    const noteUri = "https://mastodon-url.example/ap/users/1/statuses/never-fetched-note-000000000";
    await withRemoteDocuments({ [noteUri]: {} }, async (fetched) => {
      const found = await search("search-url-viewer@example.com", { q: noteUri });
      expect(found.status).toBe(200);
      expect(read(ApiSearchResults, found.body).statuses).toEqual([]);
      expect(fetched).toEqual([]);
    });
  });

  it("returns a local post for its own URI and for its page URL", async () => {
    const author = "search-url-local-author@example.com";
    const status = await post(author, "a local post found by its own address");
    expect(new TextEncoder().encode(status.uri).length).toBeGreaterThan(48);
    for (const q of [status.uri, status.url ?? ""]) {
      const found = await search("search-url-viewer@example.com", { q, resolve: "true" });
      expect(found.status, q).toBe(200);
      expect(
        read(ApiSearchResults, found.body).statuses.map((entry) => entry.id),
        q,
      ).toEqual([status.id]);
    }
  });

  it("does not return a local post the viewer may not see", async () => {
    const author = "search-url-private-author@example.com";
    const status = await post(author, "followers only, not for strangers", "private");
    const found = await search("search-url-viewer@example.com", {
      q: status.uri,
      resolve: "true",
    });
    expect(found.status).toBe(200);
    expect(read(ApiSearchResults, found.body).statuses).toEqual([]);
    const own = await search(author, { q: status.uri, resolve: "true" });
    expect(read(ApiSearchResults, own.body).statuses.map((entry) => entry.id)).toEqual([status.id]);
  });

  it("finds a local post by its page URL, under its author's name only", async () => {
    const email = "search-url-page-author@example.com";
    const author = await signedInAccount(email);
    const other = await signedInAccount("search-url-page-other@example.com");
    const status = await post(email, "a local post behind its page URL");
    const ids = async (q: string) =>
      read(
        ApiSearchResults,
        (await search("search-url-viewer@example.com", { q, resolve: "true" })).body,
      ).statuses.map((entry) => entry.id);
    expect(await ids(`https://example.com/@${author.username}/${status.id}`)).toEqual([status.id]);
    expect(await ids(`https://example.com/@${other.username}/${status.id}`)).toEqual([]);
    expect(await ids(`https://example.com/users/${other.username}/statuses/${status.id}`)).toEqual(
      [],
    );
  });

  it("returns only what the URL names, with no text search beside it", async () => {
    const email = "search-url-only-author@example.com";
    const status = await post(email, "the only result of a URL search");
    // A post whose text contains the URL: a text search for the URL would find it.
    await post(email, `quoting ${status.uri} in another post`);
    const found = read(
      ApiSearchResults,
      (await search("search-url-viewer@example.com", { q: status.uri, resolve: "true" })).body,
    );
    expect(found.statuses.map((entry) => entry.id)).toEqual([status.id]);
    expect(found.accounts).toEqual([]);
    expect(found.hashtags).toEqual([]);

    // A type the resource is not: nothing, as Mastodon's `SearchService`.
    const asAccounts = read(
      ApiSearchResults,
      (
        await search("search-url-viewer@example.com", {
          q: status.uri,
          resolve: "true",
          type: "accounts",
        })
      ).body,
    );
    expect(asAccounts.accounts).toEqual([]);
    expect(asAccounts.statuses).toEqual([]);
  });
});

describe("a URL that must resolve to nothing", () => {
  const VIEWER = "search-url-refused-viewer@example.com";
  const note = (id: string, attributedTo: string, extra: Record<string, unknown> = {}) => ({
    "@context": "https://www.w3.org/ns/activitystreams",
    id,
    type: "Note",
    attributedTo,
    content: "<p>should not be stored</p>",
    published: "2026-11-14T00:00:00.000Z",
    to: [PUBLIC],
    cc: [],
    ...extra,
  });
  const stored = async (objectUri: string): Promise<number> =>
    (
      await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
        .bind(objectUri)
        .all()
    ).results.length;
  const statusesFor = async (email: string, q: string) =>
    read(ApiSearchResults, (await search(email, { q, resolve: "true", type: "statuses" })).body)
      .statuses;

  it("when the fetched document names another id", async () => {
    const author = await remoteActor("searchurlmismatch", "refused-id.example");
    const asked = "https://refused-id.example/notes/asked-for";
    const served = "https://refused-id.example/notes/another-note";
    await withRemoteDocuments({ [asked]: note(served, author.actorUri) }, async (fetched) => {
      expect(await statusesFor(VIEWER, asked)).toEqual([]);
      expect(fetched).toEqual([asked]);
    });
    expect(await stored(asked)).toBe(0);
    expect(await stored(served)).toBe(0);
  });

  it("when the note's author is on another host", async () => {
    const author = await remoteActor("searchurlvictim", "victim-host.example");
    const uri = "https://attacker-host.example/notes/claims-another-author";
    await withRemoteDocuments({ [uri]: note(uri, author.actorUri) }, async (fetched) => {
      expect(await statusesFor(VIEWER, uri)).toEqual([]);
      expect(fetched).toEqual([uri]);
    });
    expect(await stored(uri)).toBe(0);
  });

  it("when the URL's domain is suspended, without a fetch", async () => {
    const author = await remoteActor("searchurlblocked", "suspended-url.example");
    await env.DB.prepare(
      "INSERT INTO domain_blocks (id, domain, severity) VALUES ('search-url-block', ?, 'suspend')",
    )
      .bind("suspended-url.example")
      .run();
    const uri = "https://suspended-url.example/notes/from-a-suspended-domain";
    await withRemoteDocuments({ [uri]: note(uri, author.actorUri) }, async (fetched) => {
      expect(await statusesFor(VIEWER, uri)).toEqual([]);
      expect(fetched).toEqual([]);
    });
    expect(await stored(uri)).toBe(0);
  });

  it("when the viewer may not see the cached note (followers-only, not following)", async () => {
    const author = await remoteActor("searchurlprivate", "private-url.example");
    const uri = "https://private-url.example/notes/followers-only";
    expect(
      await author.send({
        id: `${uri}/create`,
        type: "Create",
        object: note(uri, author.actorUri, { to: [`${author.actorUri}/followers`] }),
      }),
    ).toBe(202);
    expect(await stored(uri)).toBe(1);
    await withRemoteDocuments({}, async () => {
      expect(await statusesFor(VIEWER, uri)).toEqual([]);
    });
  });
});
