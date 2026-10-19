import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { MastodonAccountPreviewSchema } from "./schemas";

const auth = (email: string, admin = false): Promise<Record<string, string>> =>
  accessAuthHeaders(email, { admin });

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

const AdminAccountSchema = MastodonAccountPreviewSchema.extend({
  email: z.string(),
  suspended: z.boolean(),
  silenced: z.boolean(),
  limited: z.boolean(),
  disabled: z.boolean(),
});

const adminPost = async (email: string, path: string): Promise<{ status: number; body: unknown }> =>
  json(path, { method: "POST", headers: await auth(email, true) });

describe("admin accounts", () => {
  it("lists local accounts with moderation flags", async () => {
    const adminEmail = "admacct-admin@example.com";
    const target = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("admacct-target@example.com"),
    });
    const targetId = read(MastodonAccountPreviewSchema, target.body).id;

    const list = await json("/api/v1/admin/accounts", { headers: await auth(adminEmail, true) });
    expect(list.status).toBe(200);
    const accounts = read(z.array(AdminAccountSchema), list.body);
    const found = accounts.find((account) => account.id === targetId);
    expect(found?.email).toBe("admacct-target@example.com");
    expect(found?.suspended).toBe(false);
    expect(found?.limited).toBe(false);

    expect((await json("/api/v1/admin/accounts")).status).toBe(401);
    expect(
      (await json("/api/v1/admin/accounts", { headers: await auth("admacct-plain@example.com") }))
        .status,
    ).toBe(403);
  });

  it("suspends an account: API is forbidden and the profile is gone", async () => {
    const adminEmail = "admacct-suspend-admin@example.com";
    const targetEmail = "admacct-suspend@example.com";
    const target = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth(targetEmail),
    });
    const targetId = read(MastodonAccountPreviewSchema, target.body).id;

    const suspended = await adminPost(adminEmail, `/api/v1/admin/accounts/${targetId}/suspend`);
    expect(suspended.status).toBe(200);
    const document = read(AdminAccountSchema, suspended.body);
    expect(document.suspended).toBe(true);
    // `disabled` is Mastodon's separate `disable` action, not suspension.
    expect(document.disabled).toBe(false);
    expect(document.limited).toBe(true);

    const forbidden = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth(targetEmail),
    });
    expect(forbidden.status).toBe(403);

    expect((await json(`/api/v1/accounts/${targetId}`)).status).toBe(410);

    const restored = await adminPost(adminEmail, `/api/v1/admin/accounts/${targetId}/unsuspend`);
    expect(restored.status).toBe(200);
    expect(read(AdminAccountSchema, restored.body).suspended).toBe(false);
    expect(
      (await json("/api/v1/accounts/verify_credentials", { headers: await auth(targetEmail) }))
        .status,
    ).toBe(200);
  });

  it("silences an account: statuses leave public timelines and the directory", async () => {
    const adminEmail = "admacct-silence-admin@example.com";
    const targetEmail = "admacct-silence@example.com";
    const target = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth(targetEmail),
    });
    const targetId = read(MastodonAccountPreviewSchema, target.body).id;

    const created = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(targetEmail)) },
      body: JSON.stringify({ status: "silence me #silencewave" }),
    });
    expect(created.status).toBe(200);
    const statusId = read(z.object({ id: z.string().min(1) }), created.body).id;

    const publicIds = async (): Promise<string[]> => {
      const response = await json("/api/v1/timelines/public");
      expect(response.status).toBe(200);
      return read(z.array(z.object({ id: z.string().min(1) })), response.body).map((s) => s.id);
    };
    expect(await publicIds()).toContain(statusId);

    expect((await adminPost(adminEmail, `/api/v1/admin/accounts/${targetId}/silence`)).status).toBe(
      200,
    );
    expect(await publicIds()).not.toContain(statusId);

    const suggestions = await json("/api/v1/suggestions", {
      headers: await auth("admacct-viewer@example.com"),
    });
    expect(
      read(z.array(MastodonAccountPreviewSchema), suggestions.body).map((a) => a.id),
    ).not.toContain(targetId);

    const unsilenced = await adminPost(adminEmail, `/api/v1/admin/accounts/${targetId}/unsilence`);
    expect(read(AdminAccountSchema, unsilenced.body).silenced).toBe(false);
    expect(await publicIds()).toContain(statusId);
  });

  it("404s for an unknown target", async () => {
    const response = await adminPost(
      "admacct-missing@example.com",
      "/api/v1/admin/accounts/does-not-exist/suspend",
    );
    expect(response.status).toBe(404);
  });
});
