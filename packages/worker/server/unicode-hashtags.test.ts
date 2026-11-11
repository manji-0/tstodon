import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiHashtag, ApiSearchResults, ApiStatus } from "@tstodon/api";
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

const tag = encodeURIComponent("日本語タグ");

const postStatus = async (email: string, text: string): Promise<z.infer<typeof ApiStatus>> => {
  const posted = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status: text }),
  });
  expect(posted.status).toBe(200);
  return read(ApiStatus, posted.body);
};

describe("hashtags outside ASCII, as the compose form shows them", () => {
  it("are a status's tags, normalized", async () => {
    const status = await postStatus(
      "unicode-tags-doc@example.com",
      "こんにちは #日本語 と ＃ＷＩＤＥ",
    );
    expect(status.tags).toEqual([
      { name: "日本語", url: "https://example.com/tags/%E6%97%A5%E6%9C%AC%E8%AA%9E" },
      { name: "wide", url: "https://example.com/tags/wide" },
    ]);
  });

  it("are listed, followed and found", async () => {
    const email = "unicode-tags@example.com";
    const status = await postStatus(email, "こんにちは #日本語タグ");

    const timeline = await json(`/api/v1/timelines/tag/${tag}`);
    expect(timeline.status).toBe(200);
    expect(read(z.array(ApiStatus), timeline.body).map((s) => s.id)).toContain(status.id);

    const followed = await json(`/api/v1/tags/${tag}/follow`, {
      method: "POST",
      headers: await authHeaders(email),
    });
    expect(followed.status).toBe(200);
    expect(read(ApiHashtag, followed.body)).toMatchObject({ name: "日本語タグ", following: true });

    const found = await json(`/api/v2/search?type=hashtags&q=${encodeURIComponent("日本語タ")}`, {
      headers: await authHeaders(email),
    });
    expect(found.status).toBe(200);
    expect(read(ApiSearchResults, found.body).hashtags.map((t) => t.name)).toContain("日本語タグ");
  });
});
