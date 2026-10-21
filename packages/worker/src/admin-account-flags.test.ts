import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { MastodonAccountPreviewSchema } from "../test/mastodon-preview-schemas";

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
  sensitized: z.boolean(),
});

const accountIdFor = async (email: string): Promise<string> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(MastodonAccountPreviewSchema, response.body).id;
};

const adminPost = async (email: string, path: string): Promise<{ status: number; body: unknown }> =>
  json(path, { method: "POST", headers: await auth(email, true) });

describe("admin account sensitize and delete", () => {
  it("forces sensitive on an account's media until unsensitized", async () => {
    const adminEmail = "sensitize-admin@example.com";
    const authorEmail = "sensitize-author@example.com";
    const authorId = await accountIdFor(authorEmail);

    const form = new FormData();
    form.set("file", new File([new Uint8Array([7, 7])], "a.png", { type: "image/png" }));
    const uploaded = await json("/api/v2/media", {
      method: "POST",
      headers: await auth(authorEmail),
      body: form,
    });
    const mediaId = read(z.object({ id: z.string().min(1) }), uploaded.body).id;

    const created = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(authorEmail)) },
      body: JSON.stringify({ status: "media post", media_ids: [mediaId] }),
    });
    const statusId = read(z.object({ id: z.string().min(1) }), created.body).id;
    const sensitiveOf = async (): Promise<boolean> => {
      const response = await json(`/api/v1/statuses/${statusId}`);
      expect(response.status).toBe(200);
      return read(z.object({ sensitive: z.boolean() }), response.body).sensitive;
    };
    expect(await sensitiveOf()).toBe(false);

    const sensitized = await adminPost(adminEmail, `/api/v1/admin/accounts/${authorId}/sensitize`);
    expect(sensitized.status).toBe(200);
    expect(read(AdminAccountSchema, sensitized.body).sensitized).toBe(true);
    expect(await sensitiveOf()).toBe(true);

    const unsensitized = await adminPost(
      adminEmail,
      `/api/v1/admin/accounts/${authorId}/unsensitize`,
    );
    expect(unsensitized.status).toBe(200);
    expect(read(AdminAccountSchema, unsensitized.body).sensitized).toBe(false);
    expect(await sensitiveOf()).toBe(false);
  });

  it("purges an account and its rows", async () => {
    const adminEmail = "purge-admin@example.com";
    const targetEmail = "purge-target@example.com";
    const targetId = await accountIdFor(targetEmail);
    const created = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(targetEmail)) },
      body: JSON.stringify({ status: "about to be purged" }),
    });
    const statusId = read(z.object({ id: z.string().min(1) }), created.body).id;
    expect((await json(`/api/v1/statuses/${statusId}`)).status).toBe(200);

    const purged = await json(`/api/v1/admin/accounts/${targetId}`, {
      method: "DELETE",
      headers: await auth(adminEmail, true),
    });
    expect(purged.status).toBe(200);
    expect((await json(`/api/v1/statuses/${statusId}`)).status).toBe(404);
    expect((await json(`/api/v1/accounts/${targetId}`)).status).toBe(404);
    expect(
      (
        await json(`/api/v1/admin/accounts/${targetId}`, {
          method: "DELETE",
          headers: await auth(adminEmail, true),
        })
      ).status,
    ).toBe(404);
  });
});
