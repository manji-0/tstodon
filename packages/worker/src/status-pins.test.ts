import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { schemaResult } from "@tstodon/core";
import { MastodonAccountPreviewSchema, MastodonStatusPreviewSchema } from "./schemas";

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

const postStatus = async (email: string, payload: Record<string, unknown>): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  return read(MastodonStatusPreviewSchema, response.body).id;
};

const pinnedIds = async (accountId: string): Promise<string[]> => {
  const response = await json(`/api/v1/accounts/${accountId}/statuses?pinned=true`);
  expect(response.status).toBe(200);
  return read(z.array(MastodonStatusPreviewSchema), response.body).map((status) => status.id);
};

const pin = async (email: string, statusId: string, verb = "pin") =>
  json(`/api/v1/statuses/${statusId}/${verb}`, {
    method: "POST",
    headers: await auth(email),
  });

describe("pinned statuses", () => {
  it("pins and unpins a status", async () => {
    const email = "pin-owner@example.com";
    const accountId = await accountIdFor(email);
    const statusId = await postStatus(email, { status: "pin me" });

    expect((await pin(email, statusId)).status).toBe(200);
    expect(await pinnedIds(accountId)).toContain(statusId);

    expect((await pin(email, statusId, "unpin")).status).toBe(200);
    expect(await pinnedIds(accountId)).not.toContain(statusId);
  });

  it("enforces the five-pin limit", async () => {
    const email = "pin-limit@example.com";
    await accountIdFor(email);
    for (let index = 0; index < 5; index += 1) {
      const statusId = await postStatus(email, { status: `pinned ${index}` });
      expect((await pin(email, statusId)).status).toBe(200);
    }
    const overflow = await postStatus(email, { status: "one too many" });
    expect((await pin(email, overflow)).status).toBe(422);
  });

  it("rejects pinning a direct status", async () => {
    const email = "pin-direct@example.com";
    await accountIdFor("pin-mention@example.com");
    await accountIdFor(email);
    const statusId = await postStatus(email, {
      status: "@pin_mention secret",
      visibility: "direct",
    });
    expect((await pin(email, statusId)).status).toBe(422);
  });

  it("404s when pinning someone else's status", async () => {
    const statusId = await postStatus("pin-other@example.com", { status: "not yours" });
    await accountIdFor("pin-intruder@example.com");
    const response = await json(`/api/v1/statuses/${statusId}/pin`, {
      method: "POST",
      headers: await auth("pin-intruder@example.com"),
    });
    expect(response.status).toBe(404);
  });
});
