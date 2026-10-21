import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { pendingAccountIds } from "./account-flag-store";
import { provisionAccountFromEmail } from "./account-store";
import { registrationApprovalRequired } from "./runtime-config";
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
  email: z.string(),
  approved: z.boolean(),
  disabled: z.boolean(),
  suspended: z.boolean(),
  limited: z.boolean(),
});

const adminList = async (
  email: string,
  query = "",
): Promise<z.infer<typeof AdminAccountSchema>[]> => {
  const response = await json(`/api/v1/admin/accounts${query}`, {
    headers: await auth(email, { admin: true }),
  });
  expect(response.status).toBe(200);
  return read(z.array(AdminAccountSchema), response.body);
};

const searchAccountIds = async (query: string): Promise<string[]> => {
  const response = await json(`/api/v2/search?q=${encodeURIComponent(query)}&type=accounts`);
  expect(response.status).toBe(200);
  return read(
    z.object({ accounts: z.array(MastodonAccountPreviewSchema) }),
    response.body,
  ).accounts.map((account) => account.id);
};

const directoryIds = async (): Promise<string[]> => {
  const response = await json("/api/v1/directory?limit=80");
  expect(response.status).toBe(200);
  return read(z.array(MastodonAccountPreviewSchema), response.body).map((account) => account.id);
};

describe("registration approval", () => {
  it("reads the approval switch from the environment", () => {
    expect(registrationApprovalRequired(env)).toBe(false);
    expect(registrationApprovalRequired({ REGISTRATION_APPROVAL: "true" })).toBe(true);
    expect(registrationApprovalRequired({ REGISTRATION_APPROVAL: " TRUE " })).toBe(true);
    expect(registrationApprovalRequired({ REGISTRATION_APPROVAL: "no" })).toBe(false);
  });

  it("keeps an unapproved account out of search, the directory, and trends until approved", async () => {
    const email = "approval-pending@example.com";
    const provisioned = await provisionAccountFromEmail(env.DB, email, { pending: true });
    expect(provisioned.isOk()).toBe(true);
    const account = provisioned._unsafeUnwrap();
    const username = account.username;
    const id = account.id;

    expect(
      (await adminList("approval-admin@example.com", "?pending=true")).map((row) => row.id),
    ).toEqual([id]);
    // The document reports the pending state.
    const listed = (await adminList("approval-admin@example.com")).find((row) => row.id === id);
    expect(listed?.approved).toBe(false);
    // Unapproved accounts are not searchable (Mastodon's `Account.searchable`).
    expect(await searchAccountIds(username)).not.toContain(id);
    expect(await directoryIds()).not.toContain(id);

    // Approving publishes the account.
    const approved = await json(`/api/v1/admin/accounts/${id}/approve`, {
      method: "POST",
      headers: await auth("approval-admin@example.com", { admin: true }),
    });
    expect(approved.status).toBe(200);
    expect(read(AdminAccountSchema, approved.body).approved).toBe(true);
    expect((await adminList("approval-admin@example.com", "?pending=true")).length).toBe(0);
    expect(await searchAccountIds(username)).toContain(id);
    expect(await directoryIds()).toContain(id);

    const pending = await pendingAccountIds(env.DB, [id]);
    expect(pending.isOk() && pending.value.size).toBe(0);
  });

  it("rejects a pending account by deleting it", async () => {
    const email = "approval-reject@example.com";
    const provisioned = await provisionAccountFromEmail(env.DB, email, { pending: true });
    expect(provisioned.isOk()).toBe(true);
    const id = provisioned._unsafeUnwrap().id;

    const rejected = await json(`/api/v1/admin/accounts/${id}/reject`, {
      method: "POST",
      headers: await auth("approval-admin2@example.com", { admin: true }),
    });
    expect(rejected.status).toBe(200);
    // The documented response is the rejected account document.
    expect(read(AdminAccountSchema, rejected.body).approved).toBe(false);
    // And the account is gone.
    expect((await json(`/api/v1/accounts/${id}`)).status).toBe(404);
    expect(await searchAccountIds("approval_reject")).not.toContain(id);
  });

  it("lists local active accounts by default and filters the rest", async () => {
    const admin = "approval-filter-admin@example.com";
    const target = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("approval-filter-target@example.com"),
    });
    const targetId = read(MastodonAccountPreviewSchema, target.body).id;

    expect((await adminList(admin)).map((row) => row.id)).toContain(targetId);

    const suspended = await json(`/api/v1/admin/accounts/${targetId}/suspend`, {
      method: "POST",
      headers: await auth(admin, { admin: true }),
    });
    expect(suspended.status).toBe(200);

    // Suspended accounts leave the default (active) page.
    expect((await adminList(admin)).map((row) => row.id)).not.toContain(targetId);
    expect((await adminList(admin, "?suspended=true")).map((row) => row.id)).toContain(targetId);
    // This instance has no remote or disabled accounts.
    expect(await adminList(admin, "?remote=true")).toEqual([]);
    expect(await adminList(admin, "?disabled=true")).toEqual([]);
    // Filters combine with AND: the suspended target is only listed when its
    // status filter matches too.
    expect(await adminList(admin, "?username=approval_filter_target")).toEqual([]);
    expect(
      (await adminList(admin, "?username=approval_filter_target&suspended=true")).map(
        (row) => row.id,
      ),
    ).toEqual([targetId]);
  });

  it("serves a single admin account and 404s for an unknown one", async () => {
    const admin = "approval-single-admin@example.com";
    const target = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("approval-single-target@example.com"),
    });
    const targetId = read(MastodonAccountPreviewSchema, target.body).id;

    const single = await json(`/api/v1/admin/accounts/${targetId}`, {
      headers: await auth(admin, { admin: true }),
    });
    expect(single.status).toBe(200);
    const document = read(AdminAccountSchema, single.body);
    expect(document.id).toBe(targetId);
    expect(document.approved).toBe(true);
    expect(document.disabled).toBe(false);

    expect(
      (
        await json("/api/v1/admin/accounts/does-not-exist", {
          headers: await auth(admin, { admin: true }),
        })
      ).status,
    ).toBe(404);
  });
});
