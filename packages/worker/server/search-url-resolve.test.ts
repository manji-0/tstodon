import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import type { z } from "zod";
import { ApiSearchResults, ApiStatus } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
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
});
