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

const AccountSchema = z.object({ id: z.string().min(1) });

const post = async (email: string, status: string): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify({ status, visibility: "public" }),
  });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

const engage = async (email: string, path: string): Promise<void> => {
  const response = await json(path, { method: "POST", headers: await auth(email) });
  expect(response.status).toBe(200);
};

const page = async (path: string): Promise<{ ids: string[]; link: string; status: number }> => {
  const response = await SELF.fetch(`https://example.com${path}`);
  const body = await response.clone().json();
  return {
    ids: Array.isArray(body) ? read(z.array(AccountSchema), body).map((account) => account.id) : [],
    link: response.headers.get("link") ?? "",
    status: response.status,
  };
};

const senderId = async (email: string): Promise<string> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  return read(AccountSchema, response.body).id;
};

describe("favourited_by and reblogged_by pagination", () => {
  it("pages favourited_by by the engagement row id in the Link header", async () => {
    const author = "engagement-fav-author@example.com";
    const statusId = await post(author, "who favourited this?");
    const fanA = await senderId("engagement-fav-a@example.com");
    const fanB = await senderId("engagement-fav-b@example.com");
    await engage("engagement-fav-a@example.com", `/api/v1/statuses/${statusId}/favourite`);
    await engage("engagement-fav-b@example.com", `/api/v1/statuses/${statusId}/favourite`);

    const all = await page(`/api/v1/statuses/${statusId}/favourited_by`);
    expect(all.status).toBe(200);
    expect(all.ids).toEqual(expect.arrayContaining([fanA, fanB]));

    const firstPage = await page(`/api/v1/statuses/${statusId}/favourited_by?limit=1`);
    expect(firstPage.ids).toHaveLength(1);
    expect(firstPage.link).toContain('rel="next"');
    expect(firstPage.link).toContain("since_id=");
    const next = /max_id=([^&>]+)>; rel="next"/.exec(firstPage.link)?.[1];
    expect(next).toBeDefined();

    const secondPage = await page(
      `/api/v1/statuses/${statusId}/favourited_by?limit=1&max_id=${next ?? ""}`,
    );
    expect(secondPage.ids).toHaveLength(1);
    expect(secondPage.ids[0]).not.toBe(firstPage.ids[0]);
    expect([fanA, fanB]).toContain(secondPage.ids[0]);

    // `min_id` with the older row id comes back to the newest favourite.
    const olderRow = /since_id=([^&>]+)>; rel="prev"/.exec(secondPage.link)?.[1];
    expect(olderRow).toBeDefined();
    const back = await page(`/api/v1/statuses/${statusId}/favourited_by?min_id=${olderRow ?? ""}`);
    expect(back.ids).toEqual(firstPage.ids);
  });

  it("pages reblogged_by the same way", async () => {
    const author = "engagement-boost-author@example.com";
    const statusId = await post(author, "who boosted this?");
    const boosterA = await senderId("engagement-boost-a@example.com");
    const boosterB = await senderId("engagement-boost-b@example.com");
    await engage("engagement-boost-a@example.com", `/api/v1/statuses/${statusId}/reblog`);
    await engage("engagement-boost-b@example.com", `/api/v1/statuses/${statusId}/reblog`);

    const firstPage = await page(`/api/v1/statuses/${statusId}/reblogged_by?limit=1`);
    expect(firstPage.status).toBe(200);
    expect(firstPage.ids).toHaveLength(1);
    const next = /max_id=([^&>]+)>; rel="next"/.exec(firstPage.link)?.[1];
    expect(next).toBeDefined();

    const secondPage = await page(
      `/api/v1/statuses/${statusId}/reblogged_by?limit=1&max_id=${next ?? ""}`,
    );
    expect(secondPage.ids).toHaveLength(1);
    expect(secondPage.ids[0]).not.toBe(firstPage.ids[0]);
    expect([boosterA, boosterB]).toContain(secondPage.ids[0]);
  });
});
