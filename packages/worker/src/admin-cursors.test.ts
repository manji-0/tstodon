import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";

const auth = (
  email: string,
  options?: Readonly<{ admin?: boolean }>,
): Promise<Record<string, string>> => accessAuthHeaders(email, options);

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

const IdsSchema = z.array(z.object({ id: z.string().min(1) }));

describe("admin list cursors", () => {
  it("pages the admin account list by id", async () => {
    const admin = "cursor-admin@example.com";
    for (const name of ["cursor-a", "cursor-b", "cursor-c"]) {
      const created = await json("/api/v1/accounts/verify_credentials", {
        headers: await auth(`${name}@example.com`),
      });
      expect(created.status).toBe(200);
    }
    const list = async (query = ""): Promise<string[]> => {
      const response = await json(`/api/v1/admin/accounts${query}`, {
        headers: await auth(admin, { admin: true }),
      });
      expect(response.status).toBe(200);
      return read(IdsSchema, response.body).map((row) => row.id);
    };

    const all = await list("?limit=200");
    expect(all.length).toBeGreaterThanOrEqual(4);

    // Newest first, and max_id pages older.
    const firstPage = await list("?limit=2");
    expect(firstPage).toEqual(all.slice(0, 2));
    expect(await list(`?limit=2&max_id=${firstPage[1] ?? ""}`)).toEqual(all.slice(2, 4));
    // since_id pages newer, newest first; min_id pages newer, oldest first.
    expect(await list(`?since_id=${all[2] ?? ""}`)).toEqual(all.slice(0, 2));
    expect(await list(`?min_id=${all[2] ?? ""}`)).toEqual(all.slice(0, 2).toReversed());
  });

  it("pages the admin domain block list by id", async () => {
    const admin = "cursor-block-admin@example.com";
    for (const domain of ["cursor-one.example", "cursor-two.example", "cursor-three.example"]) {
      const blocked = await json("/api/v1/admin/domain_blocks", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await auth(admin, { admin: true })) },
        body: JSON.stringify({ domain, severity: "silence" }),
      });
      expect(blocked.status).toBe(200);
    }
    const list = async (query = ""): Promise<string[]> => {
      const response = await json(`/api/v1/admin/domain_blocks${query}`, {
        headers: await auth(admin, { admin: true }),
      });
      expect(response.status).toBe(200);
      return read(IdsSchema, response.body).map((row) => row.id);
    };

    const all = await list();
    expect(all).toHaveLength(3);
    const page = await list("?limit=1");
    expect(page).toEqual([all[0]]);
    expect(await list(`?limit=1&max_id=${page[0] ?? ""}`)).toEqual([all[1]]);
    expect(await list(`?min_id=${all[2] ?? ""}`)).toEqual(all.slice(0, 2).toReversed());
  });

  it("pages the block list by the ids in its Link header", async () => {
    const viewerEmail = "cursor-collections@example.com";
    await json("/api/v1/accounts/verify_credentials", { headers: await auth(viewerEmail) });

    for (const name of ["blocked-a", "blocked-b", "blocked-c"]) {
      const created = await json("/api/v1/accounts/verify_credentials", {
        headers: await auth(`${name}@example.com`),
      });
      const id = read(z.object({ id: z.string().min(1) }), created.body).id;
      const blocked = await json(`/api/v1/accounts/${id}/block`, {
        method: "POST",
        headers: await auth(viewerEmail),
      });
      expect(blocked.status).toBe(200);
    }

    const page = await SELF.fetch("https://example.com/api/v1/blocks?limit=2", {
      headers: await auth(viewerEmail),
    });
    expect(page.status).toBe(200);
    const firstPage = read(z.array(z.object({ id: z.string().min(1) })), await page.clone().json());
    expect(firstPage).toHaveLength(2);
    const link = page.headers.get("link") ?? "";
    // The cursor is the block row id, parsed out of the Link header.
    const next = /max_id=([^&>]+)>; rel="next"/.exec(link)?.[1];
    expect(next).toBeDefined();

    const second = await SELF.fetch(
      `https://example.com/api/v1/blocks?limit=2&max_id=${next ?? ""}`,
      { headers: await auth(viewerEmail) },
    );
    expect(second.status).toBe(200);
    const secondPage = read(
      z.array(z.object({ id: z.string().min(1) })),
      await second.clone().json(),
    );
    expect(secondPage.length).toBeGreaterThanOrEqual(1);
    const firstIds = firstPage.map((account) => account.id);
    for (const account of secondPage) {
      expect(firstIds).not.toContain(account.id);
    }
  });

  it("sets Link headers on notifications and favourites", async () => {
    const email = "cursor-headers@example.com";
    const friend = await auth("cursor-headers-friend@example.com");
    const posted = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...friend },
      body: JSON.stringify({ status: "favourite me", visibility: "public" }),
    });
    expect(posted.status).toBe(200);
    const statusId = read(z.object({ id: z.string().min(1) }), posted.body).id;
    const favourited = await json(`/api/v1/statuses/${statusId}/favourite`, {
      method: "POST",
      headers: await auth(email),
    });
    expect(favourited.status).toBe(200);

    const favourites = await SELF.fetch("https://example.com/api/v1/favourites", {
      headers: await auth(email),
    });
    expect(favourites.status).toBe(200);
    expect(favourites.headers.get("link") ?? "").toContain('rel="prev"');

    // The friend favourited nothing, so the favourite notification went to them.
    const notifications = await SELF.fetch("https://example.com/api/v1/notifications", {
      headers: friend,
    });
    expect(notifications.status).toBe(200);
    expect(notifications.headers.get("link") ?? "").toContain('rel="prev"');
  });
});
