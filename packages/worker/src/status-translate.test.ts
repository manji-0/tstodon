import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";

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

const postStatus = async (email: string, payload: Record<string, unknown>): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

describe("status translation", () => {
  it("reports translation unavailable for an eligible public status", async () => {
    const email = "translate-author@example.com";
    const statusId = await postStatus(email, { status: "hello world", language: "en" });

    const response = await json(`/api/v1/statuses/${statusId}/translate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await auth("translate-reader@example.com")),
      },
      body: JSON.stringify({ lang: "de" }),
    });
    expect(response.status).toBe(503);
    expect(read(z.object({ error: z.string() }), response.body).error).toBe("Service Unavailable");
  });

  it("refuses statuses Mastodon would not translate", async () => {
    const email = "translate-private@example.com";
    const mention = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("translate-mention@example.com"),
    });
    const mentionUsername = read(z.object({ username: z.string().min(1) }), mention.body).username;
    const privateId = await postStatus(email, {
      status: `@${mentionUsername} a private mention`,
      visibility: "direct",
    });
    const followersId = await postStatus(email, {
      status: "followers only",
      visibility: "private",
    });

    for (const statusId of [privateId, followersId]) {
      const response = await json(`/api/v1/statuses/${statusId}/translate`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await auth(email)) },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(403);
    }
  });

  it("404s for unknown statuses and requires auth", async () => {
    const authed = await json("/api/v1/statuses/does-not-exist/translate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await auth("translate-missing@example.com")),
      },
      body: JSON.stringify({}),
    });
    expect(authed.status).toBe(404);
    expect((await json("/api/v1/statuses/whatever/translate", { method: "POST" })).status).toBe(
      401,
    );
  });

  it("reports no translation languages", async () => {
    const response = await json("/api/v1/instance/translation_languages");
    expect(response.status).toBe(200);
    expect(read(z.object({}).passthrough(), response.body)).toEqual({});
  });
});
