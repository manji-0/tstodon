import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { MastodonAccountPreviewSchema } from "../test/mastodon-preview-schemas";

const auth = (email: string): Promise<Record<string, string>> => accessAuthHeaders(email);

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

const TagSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().min(1),
  history: z.array(z.object({ day: z.string(), uses: z.string(), accounts: z.string() })),
  following: z.boolean(),
});

const FeaturedTagSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().min(1),
  statuses_count: z.number(),
  last_status_at: z.string().nullable(),
});

const accountIdFor = async (email: string): Promise<string> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(MastodonAccountPreviewSchema, response.body).id;
};

const postStatus = async (email: string, text: string): Promise<void> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify({ status: text }),
  });
  expect(response.status).toBe(200);
};

const post = async (path: string, email: string): Promise<{ status: number; body: unknown }> =>
  json(path, { method: "POST", headers: await auth(email) });

describe("tags", () => {
  it("serves a tag document with a week of history", async () => {
    await postStatus("tag-author@example.com", "talking about #tagwave today");
    const response = await json("/api/v1/tags/tagwave");
    expect(response.status).toBe(200);
    const tag = read(TagSchema, response.body);
    expect(tag.name).toBe("tagwave");
    expect(tag.history).toHaveLength(7);
    expect(Number(tag.history[0]?.uses ?? "0")).toBeGreaterThanOrEqual(1);
    expect(tag.following).toBe(false);
  });

  it("follows and unfollows a tag", async () => {
    const email = "tag-follower@example.com";
    const followed = await json("/api/v1/tags/followwave/follow", {
      method: "POST",
      headers: await auth(email),
    });
    expect(followed.status).toBe(200);
    expect(read(TagSchema, followed.body).following).toBe(true);

    const list = await json("/api/v1/followed_tags", { headers: await auth(email) });
    expect(list.status).toBe(200);
    expect(read(z.array(TagSchema), list.body).map((tag) => tag.name)).toContain("followwave");

    const unfollowed = await json("/api/v1/tags/followwave/unfollow", {
      method: "POST",
      headers: await auth(email),
    });
    expect(unfollowed.status).toBe(200);
    const after = await json("/api/v1/followed_tags", { headers: await auth(email) });
    expect(read(z.array(TagSchema), after.body).map((tag) => tag.name)).not.toContain("followwave");
  });

  it("features and unfeatures a tag", async () => {
    const email = "tag-featurer@example.com";
    const accountId = await accountIdFor(email);
    await postStatus(email, "a note tagged #featurewave");

    const created = await json("/api/v1/featured_tags", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ name: "#featurewave" }),
    });
    expect(created.status).toBe(200);
    const featured = read(FeaturedTagSchema, created.body);
    expect(featured.id).toBe("featurewave");
    expect(featured.statuses_count).toBeGreaterThanOrEqual(1);

    const mine = await json("/api/v1/featured_tags", { headers: await auth(email) });
    expect(read(z.array(FeaturedTagSchema), mine.body).map((tag) => tag.name)).toContain(
      "featurewave",
    );

    const theirs = await json(`/api/v1/accounts/${accountId}/featured_tags`);
    expect(theirs.status).toBe(200);
    expect(read(z.array(FeaturedTagSchema), theirs.body).map((tag) => tag.name)).toContain(
      "featurewave",
    );

    const removed = await json("/api/v1/featured_tags/featurewave", {
      method: "DELETE",
      headers: await auth(email),
    });
    expect(removed.status).toBe(200);
    const after = await json("/api/v1/featured_tags", { headers: await auth(email) });
    expect(read(z.array(FeaturedTagSchema), after.body)).toEqual([]);
  });

  it("suggests tags the account used but has not featured", async () => {
    const email = "tag-suggester@example.com";
    await postStatus(email, "suggesting #suggestwave");
    const response = await json("/api/v1/featured_tags/suggestions", {
      headers: await auth(email),
    });
    expect(response.status).toBe(200);
    expect(read(z.array(TagSchema), response.body).map((tag) => tag.name)).toContain("suggestwave");
  });

  it("caps featured tags at ten", async () => {
    const email = "tag-limiter@example.com";
    for (let index = 0; index < 10; index += 1) {
      const response = await json("/api/v1/featured_tags", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await auth(email)) },
        body: JSON.stringify({ name: `limitwave${index}` }),
      });
      expect(response.status).toBe(200);
    }
    const overflow = await json("/api/v1/featured_tags", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ name: "limitwave-overflow" }),
    });
    expect(overflow.status).toBe(422);
  });

  it("lists followed tags with each tag's own history and featuring flag", async () => {
    const email = "tag-many@example.com";
    // A status counts once per tag, however often the tag repeats in it.
    await postStatus(email, "#manyalpha #manyalpha and #manybeta");
    await postStatus(email, "again #manyalpha");
    for (const name of ["manyalpha", "manybeta", "manygamma"]) {
      expect((await post(`/api/v1/tags/${name}/follow`, email)).status).toBe(200);
    }
    const featured = await json("/api/v1/featured_tags", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ name: "manybeta" }),
    });
    expect(featured.status).toBe(200);

    const list = await json("/api/v1/followed_tags", { headers: await auth(email) });
    expect(list.status).toBe(200);
    const tags = read(z.array(TagSchema.extend({ featuring: z.boolean() })), list.body);
    const today = (name: string) => tags.find((tag) => tag.name === name)?.history[0];
    expect(today("manyalpha")).toMatchObject({ uses: "2", accounts: "1" });
    expect(today("manybeta")).toMatchObject({ uses: "1", accounts: "1" });
    expect(today("manygamma")).toMatchObject({ uses: "0", accounts: "0" });
    expect(tags.find((tag) => tag.name === "manybeta")?.featuring).toBe(true);
    expect(tags.find((tag) => tag.name === "manyalpha")?.featuring).toBe(false);
    expect(tags.every((tag) => tag.following && tag.history.length === 7)).toBe(true);
  });

  it("requires authentication to follow a tag", async () => {
    expect((await json("/api/v1/tags/anything/follow", { method: "POST" })).status).toBe(401);
    expect((await post("/api/v1/tags/anything/follow", "tag-auth@example.com")).status).toBe(200);
  });
});
