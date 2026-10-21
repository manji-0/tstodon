import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { MastodonAccountPreviewSchema } from "../test/mastodon-preview-schemas";

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

const AdminAccountSchema = MastodonAccountPreviewSchema.extend({
  approved: z.boolean(),
  disabled: z.boolean(),
  silenced: z.boolean(),
  suspended: z.boolean(),
});

const adminPassword = { admin: true } as const;

const action = async (
  admin: string,
  accountId: string,
  type: string | undefined,
): Promise<{ status: number; body: unknown }> =>
  json(`/api/v1/admin/accounts/${accountId}/action`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(admin, adminPassword)) },
    body: JSON.stringify(type === undefined ? {} : { type }),
  });

const credentials = async (
  email: string,
): Promise<z.infer<typeof MastodonAccountPreviewSchema>> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(MastodonAccountPreviewSchema, response.body);
};

describe("admin account actions", () => {
  it("disables a login and enables it again", async () => {
    const admin = "action-admin@example.com";
    const targetEmail = "action-target@example.com";
    const target = await credentials(targetEmail);

    const disabled = await action(admin, target.id, "disable");
    expect(disabled.status).toBe(200);
    expect(disabled.body).toEqual({});

    // The login is blocked, like Mastodon's `disable`.
    const blocked = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth(targetEmail),
    });
    expect(blocked.status).toBe(403);

    // The profile stays visible, and `disabled` is its own flag.
    expect((await json(`/api/v1/accounts/${target.id}`)).status).toBe(200);
    const listed = await json("/api/v1/admin/accounts?disabled=true", {
      headers: await auth(admin, adminPassword),
    });
    const document = read(z.array(AdminAccountSchema), listed.body).find(
      (row) => row.id === target.id,
    );
    expect(document?.disabled).toBe(true);
    expect(document?.suspended).toBe(false);
    expect(document?.silenced).toBe(false);

    const enabled = await json(`/api/v1/admin/accounts/${target.id}/enable`, {
      method: "POST",
      headers: await auth(admin, adminPassword),
    });
    expect(enabled.status).toBe(200);
    expect(read(AdminAccountSchema, enabled.body).disabled).toBe(false);
    expect(
      (
        await json("/api/v1/accounts/verify_credentials", {
          headers: await auth(targetEmail),
        })
      ).status,
    ).toBe(200);
  });

  it("silences, sensitizes, and suspends through the action endpoint", async () => {
    const admin = "action2-admin@example.com";
    const silencedTarget = await credentials("action2-silenced@example.com");
    const sensitizedTarget = await credentials("action2-sensitive@example.com");
    const suspendedTarget = await credentials("action2-suspended@example.com");

    expect((await action(admin, silencedTarget.id, "silence")).status).toBe(200);
    expect((await action(admin, sensitizedTarget.id, "sensitive")).status).toBe(200);
    expect((await action(admin, suspendedTarget.id, "suspend")).status).toBe(200);

    const document = async (
      id: string,
    ): Promise<z.infer<typeof AdminAccountSchema> | undefined> => {
      // Each state has its own filter, and `active` excludes suspensions only.
      for (const query of ["?limit=200", "?silenced=true&limit=200", "?suspended=true&limit=200"]) {
        const listed = await json(`/api/v1/admin/accounts${query}`, {
          headers: await auth(admin, adminPassword),
        });
        const found = read(z.array(AdminAccountSchema), listed.body).find((row) => row.id === id);
        if (found) {
          return found;
        }
      }
      return undefined;
    };
    expect((await document(silencedTarget.id))?.silenced).toBe(true);
    expect((await document(suspendedTarget.id))?.suspended).toBe(true);
    // `sensitive` is reported by the public account document.
    const sensitizedAccount = await json(`/api/v1/accounts/${sensitizedTarget.id}`);
    expect(sensitizedAccount.status).toBe(200);

    // `none` changes nothing and still succeeds; the type is required.
    const none = await action(admin, silencedTarget.id, "none");
    expect(none.status).toBe(200);
    expect((await action(admin, silencedTarget.id, "warn")).status).toBe(422);
    expect((await action(admin, silencedTarget.id, undefined)).status).toBe(422);
  });

  it("404s for an unknown account", async () => {
    const response = await action("action3-admin@example.com", "missing", "disable");
    expect(response.status).toBe(404);
  });
});
