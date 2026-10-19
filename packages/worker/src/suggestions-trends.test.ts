import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { schemaResult } from "@tstodon/core";
import { MastodonAccountPreviewSchema } from "./schemas";
import { cacheLinkCard } from "./link-card";

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

describe("suggestions and trending links", () => {
  it("requires authentication for suggestions", async () => {
    expect((await json("/api/v1/suggestions")).status).toBe(401);
    expect((await json("/api/v2/suggestions")).status).toBe(401);
  });

  it("suggests accounts the viewer does not follow or block", async () => {
    const viewerId = await accountIdFor("sug-viewer@example.com");
    const followedId = await accountIdFor("sug-followed@example.com");
    const otherId = await accountIdFor("sug-other@example.com");
    expect(
      (
        await json(`/api/v1/accounts/${followedId}/follow`, {
          method: "POST",
          headers: await auth("sug-viewer@example.com"),
        })
      ).status,
    ).toBe(200);

    const v1 = await json("/api/v1/suggestions", { headers: await auth("sug-viewer@example.com") });
    expect(v1.status).toBe(200);
    const ids = read(z.array(MastodonAccountPreviewSchema), v1.body).map((account) => account.id);
    expect(ids).toContain(otherId);
    expect(ids).not.toContain(viewerId);
    expect(ids).not.toContain(followedId);

    const v2 = await json("/api/v2/suggestions", { headers: await auth("sug-viewer@example.com") });
    expect(v2.status).toBe(200);
    const grouped = read(
      z.array(z.object({ source: z.string(), account: MastodonAccountPreviewSchema })),
      v2.body,
    );
    expect(grouped.length).toBeGreaterThan(0);
    expect(grouped.every((item) => item.source === "global")).toBe(true);
    expect(grouped.map((item) => item.account.id)).toContain(otherId);
  });

  it("derives trending links from public notes", async () => {
    await postStatus(
      "link-a@example.com",
      "read https://news.example/story-1 and https://news.example/story-2",
    );
    await postStatus("link-b@example.com", "again https://news.example/story-1");

    const response = await json("/api/v1/trends/links");
    expect(response.status).toBe(200);
    const cards = read(
      z.array(z.object({ url: z.string().min(1), provider_name: z.string() })),
      response.body,
    );
    expect(cards.some((card) => card.url === "https://news.example/story-1")).toBe(true);
    expect(cards[0]?.url).toBe("https://news.example/story-1");
    expect(cards[0]?.provider_name).toBe("news.example");
  });
});

describe("tag history", () => {
  it("reports a week of history for trending and searched tags", async () => {
    await postStatus("trends-history@example.com", "hello #historywave");

    const trends = await json("/api/v1/trends/tags");
    expect(trends.status).toBe(200);
    const tags = read(
      z.array(
        z.object({
          name: z.string().min(1),
          url: z.string().min(1),
          history: z.array(z.object({ day: z.string(), uses: z.string(), accounts: z.string() })),
        }),
      ),
      trends.body,
    );
    const trended = tags.find((entry) => entry.name === "historywave");
    expect(trended?.history).toHaveLength(7);
    expect(Number(trended?.history[0]?.uses ?? "0")).toBeGreaterThanOrEqual(1);
    expect(Number(trended?.history[0]?.accounts ?? "0")).toBeGreaterThanOrEqual(1);

    const search = await json("/api/v2/search?q=%23historywave&type=hashtags", {
      headers: await auth("trends-history-viewer@example.com"),
    });
    expect(search.status).toBe(200);
    const hashtags = read(
      z.object({
        hashtags: z.array(
          z.object({
            name: z.string().min(1),
            following: z.boolean(),
            history: z.array(z.object({ day: z.string(), uses: z.string() })),
          }),
        ),
      }),
      search.body,
    );
    expect(hashtags.hashtags[0]?.name).toBe("historywave");
    expect(hashtags.hashtags[0]?.history).toHaveLength(7);
    expect(hashtags.hashtags[0]?.following).toBe(false);
  });

  it("prefers a previewed card for trending links", async () => {
    const email = "trend-links-preview@example.com";
    await postStatus(email, "look at https://trend-preview.example/story");
    await postStatus(
      "trend-links-preview2@example.com",
      "again https://trend-preview.example/story",
    );

    // Before the unfurl, the card falls back to the bare host.
    const before = await json("/api/v1/trends/links");
    const bare = read(
      z.array(z.object({ url: z.string().min(1), title: z.string() })),
      before.body,
    ).find((card) => card.url === "https://trend-preview.example/story");
    expect(bare?.title).toBe("trend-preview.example");

    // Seed the preview cache the way an unfurl would.
    const cached = await cacheLinkCard(env.DB, "https://trend-preview.example/story", {
      url: "https://trend-preview.example/story",
      title: "Previewed Story",
      description: "",
      providerName: "Preview Press",
      providerUrl: "https://trend-preview.example",
      authorName: "",
      authorUrl: "",
      image: null,
      type: "link",
    });
    expect(cached.isOk()).toBe(true);

    const after = await json("/api/v1/trends/links");
    const previewed = read(
      z.array(z.object({ url: z.string().min(1), title: z.string(), provider_name: z.string() })),
      after.body,
    ).find((card) => card.url === "https://trend-preview.example/story");
    expect(previewed?.title).toBe("Previewed Story");
    expect(previewed?.provider_name).toBe("Preview Press");
  });

  it("pages trending links with limit and offset", async () => {
    await postStatus("trend-offset-a@example.com", "one https://offset.example/first");
    await postStatus("trend-offset-b@example.com", "one https://offset.example/first");
    await postStatus("trend-offset-c@example.com", "two https://offset.example/second");

    const urls = async (query: string): Promise<string[]> => {
      const response = await json(`/api/v1/trends/links${query}`);
      expect(response.status).toBe(200);
      return read(z.array(z.object({ url: z.string().min(1) })), response.body).map(
        (card) => card.url,
      );
    };

    // Other tests in this file post links too, so assert offset slices the
    // ranking rather than hard-coding positions.
    const all = await urls("?limit=20");
    expect(all).toContain("https://offset.example/first");
    expect(all).toContain("https://offset.example/second");
    expect(await urls("?limit=2&offset=0")).toEqual(all.slice(0, 2));
    expect(await urls("?limit=2&offset=2")).toEqual(all.slice(2, 4));
    expect(await urls("?limit=1&offset=50")).toEqual([]);
  });
});
