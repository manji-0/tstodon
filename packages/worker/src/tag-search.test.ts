import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const HashtagsSchema = z.object({
  hashtags: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      history: z.array(z.object({ day: z.string(), uses: z.string(), accounts: z.string() })),
      following: z.boolean(),
    }),
  ),
});

const post = async (email: string, status: string, visibility = "public"): Promise<void> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status, visibility }),
  });
  expect(response.status).toBe(200);
};

const hashtags = async (
  query: string,
  email?: string,
): Promise<z.infer<typeof HashtagsSchema>["hashtags"]> => {
  const response = await json(`/api/v2/search?${query}`, {
    headers: email === undefined ? {} : await authHeaders(email),
  });
  expect(response.status).toBe(200);
  return read(HashtagsSchema, response.body).hashtags;
};

const names = async (query: string, email?: string): Promise<string[]> =>
  (await hashtags(query, email)).map((tag) => tag.name);

describe("hashtag search", () => {
  const viewer = "tag-search-viewer@example.com";

  it("finds stored tags by prefix, shortest first, and pages them by offset", async () => {
    await post(viewer, "a #CatsOfMastodon picture");
    await post(viewer, "more #cats and #dogs");

    expect(await names("q=cat&type=hashtags", viewer)).toEqual(["cats", "catsofmastodon"]);
    expect(await names("q=cat&type=hashtags")).toEqual(["cats", "catsofmastodon"]);
    // Case-insensitive, with or without the `#`, and with no `type`.
    expect(await names("q=%23CAT&type=hashtags", viewer)).toEqual(["cats", "catsofmastodon"]);
    expect(await names("q=cat", viewer)).toEqual(["cats", "catsofmastodon"]);

    expect(await names("q=cat&type=hashtags&limit=1&offset=0", viewer)).toEqual(["cats"]);
    expect(await names("q=cat&type=hashtags&limit=1&offset=1", viewer)).toEqual(["catsofmastodon"]);
    expect(await names("q=cat&type=hashtags&limit=1&offset=2", viewer)).toEqual([]);
  });

  it("finds no tag for a term with no tag characters", async () => {
    await post(viewer, "a #termless note");
    expect(await names("q=%23&type=hashtags", viewer)).toEqual([]);
    expect(await names("q=!!!&type=hashtags")).toEqual([]);
  });

  it("does not answer with a tag nobody has used or followed", async () => {
    expect(await names("q=%23nobodyeverusedthistag&type=hashtags", viewer)).toEqual([]);
  });

  it("renders each result as a Mastodon tag, with the viewer's follow", async () => {
    await post(viewer, "#followedfind and #followedfindtoo");
    const follow = await json("/api/v1/tags/followedfind/follow", {
      method: "POST",
      headers: await authHeaders(viewer),
    });
    expect(follow.status).toBe(200);

    const found = await hashtags("q=followedfind&type=hashtags", viewer);
    expect(found.map((tag) => [tag.name, tag.following])).toEqual([
      ["followedfind", true],
      ["followedfindtoo", false],
    ]);
    expect(found[0]?.url).toBe("https://example.com/tags/followedfind");
    expect(found[0]?.history).toHaveLength(7);
    expect(Number(found[0]?.history[0]?.uses ?? "0")).toBe(1);
  });

  it("finds a tag once it is followed, as following creates it", async () => {
    const follow = await json("/api/v1/tags/followedbeforeuse/follow", {
      method: "POST",
      headers: await authHeaders(viewer),
    });
    expect(follow.status).toBe(200);
    expect(await names("q=followedbefore&type=hashtags", viewer)).toEqual(["followedbeforeuse"]);
  });

  it("finds the tags of an edited note", async () => {
    const created = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(viewer)) },
      body: JSON.stringify({ status: "before the edit" }),
    });
    const id = read(z.object({ id: z.string() }), created.body).id;
    const edited = await json(`/api/v1/statuses/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await authHeaders(viewer)) },
      body: JSON.stringify({ status: "after the edit #addedbyedit" }),
    });
    expect(edited.status).toBe(200);
    expect(await names("q=addedby&type=hashtags", viewer)).toEqual(["addedbyedit"]);
  });

  it("does not let anyone find a tag or URL fragment only a direct or followers-only note uses", async () => {
    await post(viewer, "@nobody see https://app.example/invite#Kq8sZ2pX #dmonlytag", "direct");
    await post(viewer, "https://app.example/join#Zr7tY1qW #privateonlytag", "private");

    for (const query of [
      "q=kq8&type=hashtags",
      "q=dmonly",
      "q=zr7&type=hashtags",
      "q=privateonly",
    ]) {
      expect(await names(query)).toEqual([]);
      expect(await names(query, viewer)).toEqual([]);
    }
  });

  it("does not let anyone find a tag a followers-only note gains by an edit", async () => {
    const created = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(viewer)) },
      body: JSON.stringify({ status: "before the edit", visibility: "private" }),
    });
    const id = read(z.object({ id: z.string() }), created.body).id;
    const edited = await json(`/api/v1/statuses/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await authHeaders(viewer)) },
      body: JSON.stringify({ status: "after the edit #privateeditedtag" }),
    });
    expect(edited.status).toBe(200);
    expect(await names("q=privateedited&type=hashtags", viewer)).toEqual([]);
  });

  it("finds the tags of an unlisted note, but not a public note's URL fragment", async () => {
    await post(viewer, "https://app.example/page#PublicFrag #unlistedfound", "unlisted");
    expect(await names("q=unlistedfo&type=hashtags")).toEqual(["unlistedfound"]);
    expect(await names("q=publicfrag&type=hashtags")).toEqual([]);
  });

  it("keeps asking for sign-in to page", async () => {
    const response = await json("/api/v2/search?q=cat&type=hashtags&offset=1");
    expect(response.status).toBe(401);
  });
});
