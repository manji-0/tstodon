import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { schemaResult } from "@tstodon/core";
import { MastodonAccountPreviewSchema } from "./schemas";

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
});
