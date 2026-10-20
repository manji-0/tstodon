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

const AccountSchema = z.object({ id: z.string().min(1), acct: z.string().min(1) });

const credentials = async (email: string): Promise<{ id: string; acct: string }> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(AccountSchema, response.body);
};

const follow = async (followerEmail: string, targetId: string): Promise<void> => {
  const response = await json(`/api/v1/accounts/${targetId}/follow`, {
    method: "POST",
    headers: await auth(followerEmail),
  });
  expect(response.status).toBe(200);
};

const page = async (
  path: string,
  email: string,
): Promise<{ ids: string[]; link: string; status: number }> => {
  const response = await SELF.fetch(`https://example.com${path}`, { headers: await auth(email) });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.clone().json() : [];
  return {
    ids: read(z.array(AccountSchema), body).map((account) => account.id),
    link: response.headers.get("link") ?? "",
    status: response.status,
  };
};

describe("follower and following pagination", () => {
  it("pages followers by the follow row id in the Link header", async () => {
    const viewer = await credentials("followers-page-viewer@example.com");
    const first = await credentials("followers-page-a@example.com");
    const second = await credentials("followers-page-b@example.com");
    await follow("followers-page-a@example.com", viewer.id);
    await follow("followers-page-b@example.com", viewer.id);

    const all = await page(
      `/api/v1/accounts/${viewer.id}/followers`,
      "followers-page-viewer@example.com",
    );
    expect(all.status).toBe(200);
    expect(all.ids).toEqual(expect.arrayContaining([first.id, second.id]));

    const firstPage = await page(
      `/api/v1/accounts/${viewer.id}/followers?limit=1`,
      "followers-page-viewer@example.com",
    );
    expect(firstPage.ids).toHaveLength(1);
    const next = /max_id=([^&>]+)>; rel="next"/.exec(firstPage.link)?.[1];
    expect(next).toBeDefined();
    expect(firstPage.link).toContain('rel="prev"');
    expect(firstPage.link).toContain("since_id=");

    const secondPage = await page(
      `/api/v1/accounts/${viewer.id}/followers?limit=1&max_id=${next ?? ""}`,
      "followers-page-viewer@example.com",
    );
    expect(secondPage.ids).toHaveLength(1);
    expect(secondPage.ids[0]).not.toBe(firstPage.ids[0]);
    expect([first.id, second.id]).toContain(secondPage.ids[0]);

    // `min_id` pages forward from a follow row id (from the Link header), back
    // toward the newest follower.
    const olderRow = /since_id=([^&>]+)>; rel="prev"/.exec(secondPage.link)?.[1];
    expect(olderRow).toBeDefined();
    const back = await page(
      `/api/v1/accounts/${viewer.id}/followers?min_id=${olderRow ?? ""}`,
      "followers-page-viewer@example.com",
    );
    expect(back.ids).toEqual(firstPage.ids);
  });

  it("pages the following list the same way", async () => {
    const viewer = await credentials("following-page-viewer@example.com");
    const first = await credentials("following-page-a@example.com");
    const second = await credentials("following-page-b@example.com");
    await follow("following-page-viewer@example.com", first.id);
    await follow("following-page-viewer@example.com", second.id);

    const firstPage = await page(
      `/api/v1/accounts/${viewer.id}/following?limit=1`,
      "following-page-viewer@example.com",
    );
    expect(firstPage.ids).toHaveLength(1);
    const next = /max_id=([^&>]+)>; rel="next"/.exec(firstPage.link)?.[1];
    expect(next).toBeDefined();
    const secondPage = await page(
      `/api/v1/accounts/${viewer.id}/following?limit=1&max_id=${next ?? ""}`,
      "following-page-viewer@example.com",
    );
    expect(secondPage.ids).toHaveLength(1);
    expect(secondPage.ids[0]).not.toBe(firstPage.ids[0]);
  });
});
