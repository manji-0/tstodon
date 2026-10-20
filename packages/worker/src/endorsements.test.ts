import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
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

const RelationshipSchema = z.object({ id: z.string().min(1), endorsed: z.boolean() });
const ListSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  replies_policy: z.string().min(1),
  exclusive: z.boolean(),
});

const accountIdFor = async (email: string): Promise<string> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(MastodonAccountPreviewSchema, response.body).id;
};

describe("endorsements", () => {
  it("endorses, lists, and unendorses a local account", async () => {
    const viewer = "endorse-viewer@example.com";
    const targetId = await accountIdFor("endorse-target@example.com");
    await accountIdFor(viewer);

    const endorsed = await json(`/api/v1/accounts/${targetId}/endorse`, {
      method: "POST",
      headers: await auth(viewer),
    });
    expect(endorsed.status).toBe(200);
    expect(read(RelationshipSchema, endorsed.body).endorsed).toBe(true);

    const relationships = await json(`/api/v1/accounts/relationships?id[]=${targetId}`, {
      headers: await auth(viewer),
    });
    expect(read(z.array(RelationshipSchema), relationships.body)[0]?.endorsed).toBe(true);

    const mine = await json("/api/v1/endorsements", { headers: await auth(viewer) });
    expect(mine.status).toBe(200);
    expect(read(z.array(MastodonAccountPreviewSchema), mine.body).map((a) => a.id)).toContain(
      targetId,
    );

    const viewerId = await accountIdFor(viewer);
    const publicList = await json(`/api/v1/accounts/${viewerId}/endorsements`);
    expect(publicList.status).toBe(200);
    expect(read(z.array(MastodonAccountPreviewSchema), publicList.body).map((a) => a.id)).toContain(
      targetId,
    );

    const unendorsed = await json(`/api/v1/accounts/${targetId}/unendorse`, {
      method: "POST",
      headers: await auth(viewer),
    });
    expect(unendorsed.status).toBe(200);
    expect(read(RelationshipSchema, unendorsed.body).endorsed).toBe(false);
    const after = await json("/api/v1/endorsements", { headers: await auth(viewer) });
    expect(read(z.array(MastodonAccountPreviewSchema), after.body)).toEqual([]);
  });

  it("requires authentication and 404s for unknown targets", async () => {
    expect((await json("/api/v1/endorsements")).status).toBe(401);
    const response = await json("/api/v1/accounts/nope/endorse", {
      method: "POST",
      headers: await auth("endorse-missing@example.com"),
    });
    expect(response.status).toBe(404);
  });
});

describe("list exclusivity", () => {
  it("defaults to non-exclusive and can be toggled", async () => {
    const email = "list-exclusive@example.com";
    const created = await json("/api/v1/lists", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ title: "Friends" }),
    });
    expect(created.status).toBe(200);
    const list = read(ListSchema, created.body);
    expect(list.exclusive).toBe(false);

    const updated = await json(`/api/v1/lists/${list.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ exclusive: true }),
    });
    expect(updated.status).toBe(200);
    expect(read(ListSchema, updated.body).exclusive).toBe(true);

    const fetched = await json(`/api/v1/lists/${list.id}`, { headers: await auth(email) });
    expect(read(ListSchema, fetched.body).exclusive).toBe(true);

    const exclusiveCreate = await json("/api/v1/lists", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ title: "Only", exclusive: true }),
    });
    expect(read(ListSchema, exclusiveCreate.body).exclusive).toBe(true);
  });
});
