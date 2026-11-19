import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";

/** What Mastodon's `FetchResourceService` sends: ActivityPub first, HTML as a last resort. */
const MASTODON_ACCEPT =
  'application/ld+json; profile="https://www.w3.org/ns/activitystreams", application/activity+json, text/html;q=0.1';
const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

const AUTHOR = "apneg-author@example.com";

const post = async (status: string, visibility: string): Promise<string> => {
  const response = await SELF.fetch("https://example.com/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(AUTHOR)) },
    body: JSON.stringify({ status, visibility }),
  });
  expect(response.status).toBe(200);
  const parsed = schemaResult(ApiStatus)(await response.json());
  if (parsed.isErr()) {
    throw new Error("status rejected");
  }
  return new URL(parsed.value.uri).pathname;
};

const get = (path: string, accept: string): Promise<Response> =>
  SELF.fetch(`https://example.com${path}`, { headers: { Accept: accept }, redirect: "manual" });

const contentType = (response: Response): string => response.headers.get("content-type") ?? "";

describe("ActivityPub content negotiation with Mastodon's Accept header", () => {
  it("serves a public note as ActivityPub JSON", async () => {
    const path = await post("a public note for Mastodon to fetch", "public");
    const response = await get(path, MASTODON_ACCEPT);
    expect(response.status).toBe(200);
    expect(contentType(response)).toContain("application/activity+json");
    const note = schemaResult(z.object({ type: z.string(), id: z.string() }))(
      await response.json(),
    );
    expect(note.isOk() && note.value.type).toBe("Note");
  });

  it("answers 404, not a page, for a direct note fetched unsigned", async () => {
    const path = await post("a direct note nobody else may fetch", "direct");
    const response = await get(path, MASTODON_ACCEPT);
    expect(response.status).toBe(404);
    expect(contentType(response)).not.toContain("text/html");
  });

  it("answers 404, not a page, for a followers-only note fetched unsigned", async () => {
    const path = await post("a followers-only note", "private");
    const response = await get(path, MASTODON_ACCEPT);
    expect(response.status).toBe(404);
    expect(contentType(response)).not.toContain("text/html");
  });

  it("answers 404, not a page, for a note that does not exist", async () => {
    const author = await signedInAccount(AUTHOR);
    for (const path of [
      `/users/${author.username}/statuses/999`,
      "/users/apneg-nobody/statuses/999",
      "/users/apneg-nobody",
      "/users/apneg-nobody/outbox",
      "/users/apneg-nobody/followers",
      "/users/apneg-nobody/following",
    ]) {
      const response = await get(path, MASTODON_ACCEPT);
      expect(response.status, path).toBe(404);
      expect(contentType(response), path).not.toContain("text/html");
    }
  });

  it("serves the actor, its outbox and its collections as ActivityPub JSON", async () => {
    const author = await signedInAccount(AUTHOR);
    for (const path of ["", "/outbox", "/followers", "/following"]) {
      const response = await get(`/users/${author.username}${path}`, MASTODON_ACCEPT);
      expect(response.status, path).toBe(200);
      expect(contentType(response), path).toContain("application/activity+json");
    }
  });

  it("redirects the page URLs to the ActivityPub ones", async () => {
    const author = await signedInAccount(AUTHOR);
    const path = await post("a public note behind its page URL", "public");
    const id = path.split("/").at(-1);
    const profile = await get(`/@${author.username}`, MASTODON_ACCEPT);
    expect(profile.status).toBe(301);
    expect(profile.headers.get("location")).toBe(`/users/${author.username}`);
    const page = await get(`/@${author.username}/${id}`, MASTODON_ACCEPT);
    expect(page.status).toBe(301);
    expect(page.headers.get("location")).toBe(path);
  });
});

describe("what a browser gets for an ActivityPub URL", () => {
  // Mastodon's `redirect_with_vary` in `config/routes.rb`: a request whose
  // format is HTML (or not given) goes to the web app's page, varying by Accept.
  it("is a redirect to the page, for the actor, its follows and its notes", async () => {
    const author = await signedInAccount(AUTHOR);
    const note = await post("a public note a browser opens", "public");
    const direct = await post("a direct note a browser asks for", "direct");
    const id = (path: string) => path.split("/").at(-1);
    const user = `/users/${author.username}`;
    const pages: ReadonlyArray<readonly [string, string]> = [
      [user, `/@${author.username}`],
      [`${user}/followers`, `/@${author.username}/followers`],
      [`${user}/following`, `/@${author.username}/following`],
      [note, `/@${author.username}/${id(note)}`],
      [direct, `/@${author.username}/${id(direct)}`],
      [`${user}/statuses/999`, `/@${author.username}/999`],
      ["/users/apneg-nobody", "/@apneg-nobody"],
    ];
    for (const accept of [BROWSER_ACCEPT, "text/html", "*/*", undefined]) {
      for (const [path, page] of pages) {
        const response = await SELF.fetch(`https://example.com${path}`, {
          headers: accept === undefined ? {} : { Accept: accept },
          redirect: "manual",
        });
        expect(response.status, `${path} ${accept}`).toBe(301);
        expect(response.headers.get("location"), path).toBe(page);
        expect(response.headers.get("vary"), path).toBe("Origin, Accept");
      }
    }
  });

  it("keeps the ActivityPub document for a JSON request", async () => {
    const author = await signedInAccount(AUTHOR);
    for (const accept of ["application/json", "application/activity+json", MASTODON_ACCEPT]) {
      const response = await get(`/users/${author.username}`, accept);
      expect(response.status, accept).toBe(200);
      expect(contentType(response), accept).toContain("application/activity+json");
    }
  });

  it("is not a redirect for the outbox or the featured collections", async () => {
    const author = await signedInAccount(AUTHOR);
    for (const path of ["/outbox", "/collections/featured", "/collections/tags"]) {
      const response = await get(`/users/${author.username}${path}`, BROWSER_ACCEPT);
      expect(response.status, path).toBe(200);
    }
  });
});

describe("what an ActivityPub client gets for a page URL", () => {
  it("is a redirect that varies by Accept", async () => {
    const author = await signedInAccount(AUTHOR);
    const profile = await get(`/@${author.username}`, MASTODON_ACCEPT);
    expect(profile.status).toBe(301);
    expect(profile.headers.get("vary")).toBe("Origin, Accept");
  });
});
