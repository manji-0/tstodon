import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { isFederatedHostRefused } from "./federated-fetch";
import { federatesWithHost } from "./runtime-config";

const auth = (email: string, options?: { admin?: boolean }): Promise<Record<string, string>> =>
  accessAuthHeaders(email, options);

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

const AllowSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  created_at: z.string().min(1),
});

const admin = (email = "allows-admin@example.com") => auth(email, { admin: true });

describe("admin domain allows", () => {
  it("lists, creates idempotently, reads, and deletes an allowed domain", async () => {
    const empty = await json("/api/v1/admin/domain_allows", { headers: await admin() });
    expect(empty.status).toBe(200);
    expect(read(z.array(AllowSchema), empty.body)).toEqual([]);

    const created = await json("/api/v1/admin/domain_allows", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await admin()) },
      body: JSON.stringify({ domain: "Allow.Example" }),
    });
    expect(created.status).toBe(200);
    const document = read(AllowSchema, created.body);
    expect(document.domain).toBe("allow.example");

    // A second request answers the same row instead of failing on the duplicate.
    const again = await json("/api/v1/admin/domain_allows", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await admin()) },
      body: JSON.stringify({ domain: "allow.example" }),
    });
    expect(again.status).toBe(200);
    expect(read(AllowSchema, again.body).id).toBe(document.id);

    const listed = await json("/api/v1/admin/domain_allows", { headers: await admin() });
    expect(read(z.array(AllowSchema), listed.body).map((row) => row.domain)).toEqual([
      "allow.example",
    ]);

    const single = await json(`/api/v1/admin/domain_allows/${document.id}`, {
      headers: await admin(),
    });
    expect(single.status).toBe(200);
    expect(read(AllowSchema, single.body).id).toBe(document.id);

    const removed = await json(`/api/v1/admin/domain_allows/${document.id}`, {
      method: "DELETE",
      headers: await admin(),
    });
    expect(removed.status).toBe(200);
    expect(
      (await json(`/api/v1/admin/domain_allows/${document.id}`, { headers: await admin() })).status,
    ).toBe(404);

    // Not an admin: the endpoints are closed.
    const forbidden = await json("/api/v1/admin/domain_allows", {
      headers: await auth("allows-member@example.com"),
    });
    expect(forbidden.status).toBe(403);
  });

  it("refuses a value that is not a hostname", async () => {
    const invalid = await json("/api/v1/admin/domain_allows", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await admin()) },
      body: JSON.stringify({ domain: "https://not-a-host/with/a/path" }),
    });
    expect(invalid.status).toBe(422);
  });

  it("puts the instance in limited federation while a domain is allowed", async () => {
    const before = await json("/api/v2/instance");
    expect(before.status).toBe(200);
    const beforeDocument = read(z.object({ registrations: z.object({}) }), before.body);
    expect(beforeDocument).toBeDefined();

    const created = await json("/api/v1/admin/domain_allows", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await admin()) },
      body: JSON.stringify({ domain: "friend.example" }),
    });
    expect(created.status).toBe(200);

    const instance = await json("/api/v2/instance");
    const document = read(
      z.object({ configuration: z.object({ limited_federation: z.boolean() }) }),
      instance.body,
    );
    expect(document.configuration.limited_federation).toBe(true);

    // Peers and activity need a token under limited federation, as in Mastodon.
    expect((await json("/api/v1/instance/peers")).status).toBe(401);
    expect(
      (await json("/api/v1/instance/peers", { headers: await auth("allows-viewer@example.com") }))
        .status,
    ).toBe(200);

    const removed = await json(
      `/api/v1/admin/domain_allows/${read(AllowSchema, created.body).id}`,
      {
        method: "DELETE",
        headers: await admin(),
      },
    );
    expect(removed.status).toBe(200);
    const after = await json("/api/v2/instance");
    const afterDocument = read(
      z.object({ configuration: z.object({ limited_federation: z.boolean() }) }),
      after.body,
    );
    expect(afterDocument.configuration.limited_federation).toBe(false);
  });

  it("refuses any host outside the allow list", async () => {
    // No allow list: ordinary hosts are not refused.
    expect(isFederatedHostRefused("other.example", "example.com")).toBe(false);
    expect(await federatesWithHost(env, "other.example")).toBe(true);

    const created = await json("/api/v1/admin/domain_allows", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await admin()) },
      body: JSON.stringify({ domain: "friend.example" }),
    });
    expect(created.status).toBe(200);

    expect(await federatesWithHost(env, "friend.example")).toBe(true);
    expect(await federatesWithHost(env, "other.example")).toBe(false);
    // The shared fetch/host check refuses anything not listed.
    expect(
      isFederatedHostRefused("other.example", "example.com", {
        allowHosts: new Set(["friend.example"]),
      }),
    ).toBe(true);
    expect(
      isFederatedHostRefused("friend.example", "example.com", {
        allowHosts: new Set(["friend.example"]),
      }),
    ).toBe(false);
  });
});
