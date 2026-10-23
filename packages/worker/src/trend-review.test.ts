import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";

const auth = (email: string, options?: { admin?: boolean }): Promise<Record<string, string>> =>
  authHeaders(email, options);

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
  id: z.string(),
  name: z.string(),
  trendable: z.boolean().optional(),
  usable: z.boolean().optional(),
  requires_review: z.boolean().optional(),
});

const StatusSchema = z.object({ id: z.string(), content: z.string() });

const LinkSchema = z.object({ url: z.string(), title: z.string() });

const postStatus = async (email: string, status: string): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify({ status, visibility: "public" }),
  });
  expect(response.status).toBe(200);
  return read(StatusSchema, response.body).id;
};

const names = (body: unknown): string[] =>
  read(z.array(z.object({ name: z.string() })), body).map((tag) => tag.name);

describe("trend review", () => {
  it("hides a rejected tag from public trends and restores it on approval", async () => {
    const admin = "trend-tag-admin@example.com";
    await postStatus("trend-tag-author@example.com", "tag trend #reviewmetag");
    await postStatus("trend-tag-author2@example.com", "tag trend again #reviewmetag");

    const before = await json("/api/v1/trends/tags");
    expect(before.status).toBe(200);
    expect(names(before.body)).toContain("reviewmetag");

    const adminList = await json("/api/v1/admin/trends/tags", {
      headers: await auth(admin, { admin: true }),
    });
    expect(adminList.status).toBe(200);
    const listed = read(z.array(TagSchema), adminList.body).find(
      (tag) => tag.name === "reviewmetag",
    );
    expect(listed?.trendable).toBe(true);
    expect(listed?.usable).toBe(true);
    expect(listed?.requires_review).toBe(true);

    const rejected = await json("/api/v1/admin/trends/tags/reviewmetag/reject", {
      method: "POST",
      headers: await auth(admin, { admin: true }),
    });
    expect(rejected.status).toBe(200);
    const rejectedDocument = read(TagSchema, rejected.body);
    expect(rejectedDocument.trendable).toBe(false);
    expect(rejectedDocument.requires_review).toBe(false);

    // The public list no longer carries the rejected tag.
    expect(names((await json("/api/v1/trends/tags")).body)).not.toContain("reviewmetag");

    const approved = await json("/api/v1/admin/trends/tags/reviewmetag/approve", {
      method: "POST",
      headers: await auth(admin, { admin: true }),
    });
    expect(approved.status).toBe(200);
    expect(read(TagSchema, approved.body).trendable).toBe(true);
    expect(names((await json("/api/v1/trends/tags")).body)).toContain("reviewmetag");

    // Non-admins cannot review.
    const forbidden = await json("/api/v1/admin/trends/tags/reviewmetag/reject", {
      method: "POST",
      headers: await auth("trend-tag-author@example.com"),
    });
    expect(forbidden.status).toBe(403);
  });

  it("keeps a rejected status out of the public trends", async () => {
    const admin = "trend-status-admin@example.com";
    const statusId = await postStatus("trend-status-author@example.com", "trending status body");

    const listed = await json("/api/v1/admin/trends/statuses", {
      headers: await auth(admin, { admin: true }),
    });
    expect(listed.status).toBe(200);
    expect(read(z.array(StatusSchema), listed.body).map((status) => status.id)).toContain(statusId);

    const rejected = await json(`/api/v1/admin/trends/statuses/${statusId}/reject`, {
      method: "POST",
      headers: await auth(admin, { admin: true }),
    });
    expect(rejected.status).toBe(200);
    const publicAfter = await json("/api/v1/trends/statuses");
    expect(read(z.array(StatusSchema), publicAfter.body).map((status) => status.id)).not.toContain(
      statusId,
    );

    // The admin list still shows it, so it can be approved again.
    const stillListed = await json("/api/v1/admin/trends/statuses", {
      headers: await auth(admin, { admin: true }),
    });
    expect(read(z.array(StatusSchema), stillListed.body).map((status) => status.id)).toContain(
      statusId,
    );

    const approved = await json(`/api/v1/admin/trends/statuses/${statusId}/approve`, {
      method: "POST",
      headers: await auth(admin, { admin: true }),
    });
    expect(approved.status).toBe(200);
    expect(read(StatusSchema, approved.body).id).toBe(statusId);
  });

  it("hides a rejected link from public trends", async () => {
    const admin = "trend-link-admin@example.com";
    const url = "https://trend.example.com/rejected-article";
    await postStatus("trend-link-author@example.com", `read this ${url} please`);

    const before = await json("/api/v1/trends/links");
    expect(before.status).toBe(200);
    expect(read(z.array(LinkSchema), before.body).map((link) => link.url)).toContain(url);

    const rejected = await json(`/api/v1/admin/trends/links/${encodeURIComponent(url)}/reject`, {
      method: "POST",
      headers: await auth(admin, { admin: true }),
    });
    expect(rejected.status).toBe(200);
    expect(read(LinkSchema, rejected.body).url).toBe(url);

    const after = await json("/api/v1/trends/links");
    expect(read(z.array(LinkSchema), after.body).map((link) => link.url)).not.toContain(url);

    // The admin list keeps it visible for later approval.
    const adminList = await json("/api/v1/admin/trends/links", {
      headers: await auth(admin, { admin: true }),
    });
    expect(read(z.array(LinkSchema), adminList.body).map((link) => link.url)).toContain(url);
  });
});
