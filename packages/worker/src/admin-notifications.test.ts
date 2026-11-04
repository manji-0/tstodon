import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { createSignupAccount } from "./passkey-signup";

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

const NotificationSchema = z.object({
  id: z.string(),
  type: z.string(),
  account: z.object({ id: z.string(), username: z.string() }),
  report: z
    .object({
      id: z.string(),
      action_taken: z.boolean(),
      category: z.string(),
      comment: z.string(),
      forwarded: z.boolean(),
      created_at: z.string(),
      status_ids: z.array(z.string()),
      rule_ids: z.array(z.string()),
      target_account: z.object({ id: z.string(), username: z.string(), acct: z.string() }),
    })
    .optional(),
});

const notifications = async (
  email: string,
  options: Readonly<{ admin?: boolean }>,
  query = "",
): Promise<z.infer<typeof NotificationSchema>[]> => {
  const response = await json(`/api/v1/notifications${query}`, {
    headers: await authHeaders(email, options),
  });
  expect(response.status).toBe(200);
  return read(z.array(NotificationSchema), response.body);
};

const GroupsSchema = z.object({
  notification_groups: z.array(
    z.object({
      group_key: z.string(),
      type: z.string(),
      sample_account_ids: z.array(z.string()),
      report: z.object({ id: z.string(), target_account: z.object({ id: z.string() }) }).optional(),
    }),
  ),
});

const fileReport = async (email: string, targetId: string, comment: string): Promise<string> => {
  const response = await json("/api/v1/reports", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ account_id: targetId, comment, category: "spam" }),
  });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string() }), response.body).id;
};

/** What a passkey sign-up leaves: a Better Auth user, then `createSignupAccount`. */
const signUp = async (username: string, approval: boolean) => {
  const userId = crypto.randomUUID();
  const email = `${username}@example.com`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role)
     VALUES (?, ?, ?, 1, ?, ?, 'user')`,
  )
    .bind(userId, username, email, now, now)
    .run();
  const account = await createSignupAccount(env, { username, email }, userId, approval);
  if (account.isErr()) {
    throw new Error(`sign-up failed: ${account.error.kind}`);
  }
  return account.value;
};

describe("admin report notifications", () => {
  it("notifies admins but not the reporter or other users", async () => {
    const admin = await signedInAccount("an-admin@example.com", { admin: true });
    const secondAdmin = await signedInAccount("an-admin2@example.com", { admin: true });
    const reporter = await signedInAccount("an-reporter@example.com");
    const bystander = await signedInAccount("an-bystander@example.com");
    const target = await signedInAccount("an-target@example.com");

    const reportId = await fileReport("an-reporter@example.com", target.id, "spams replies");

    for (const email of ["an-admin@example.com", "an-admin2@example.com"]) {
      const [entry, ...rest] = await notifications(email, { admin: true });
      expect(rest).toEqual([]);
      expect(entry?.type).toBe("admin.report");
      expect(entry?.account.id).toBe(reporter.id);
      expect(entry?.report).toMatchObject({
        id: reportId,
        action_taken: false,
        category: "spam",
        comment: "spams replies",
        forwarded: false,
        status_ids: [],
        rule_ids: [],
        target_account: { id: target.id, username: target.username, acct: target.username },
      });
    }
    expect(admin.id).not.toBe(secondAdmin.id);
    expect(await notifications("an-reporter@example.com", {})).toEqual([]);
    expect(await notifications("an-bystander@example.com", {})).toEqual([]);
    expect(bystander.id).not.toBe(reporter.id);
  });

  it("does not notify an admin of their own report", async () => {
    await signedInAccount("an-self-admin@example.com", { admin: true });
    const target = await signedInAccount("an-self-target@example.com");
    await fileReport("an-self-admin@example.com", target.id, "mine");
    expect(await notifications("an-self-admin@example.com", { admin: true })).toEqual([]);
  });

  it("answers the type filters and the grouped list", async () => {
    await signedInAccount("an-filter-admin@example.com", { admin: true });
    const reporter = await signedInAccount("an-filter-reporter@example.com");
    const target = await signedInAccount("an-filter-target@example.com");
    const reportId = await fileReport("an-filter-reporter@example.com", target.id, "filtered");

    const only = await notifications(
      "an-filter-admin@example.com",
      { admin: true },
      "?types[]=admin.report",
    );
    expect(only.map((entry) => entry.report?.id)).toEqual([reportId]);
    expect(
      await notifications(
        "an-filter-admin@example.com",
        { admin: true },
        "?exclude_types[]=admin.report",
      ),
    ).toEqual([]);

    const grouped = await json("/api/v2/notifications?types[]=admin.report", {
      headers: await authHeaders("an-filter-admin@example.com", { admin: true }),
    });
    expect(grouped.status).toBe(200);
    const [group] = read(GroupsSchema, grouped.body).notification_groups;
    expect(group).toMatchObject({
      type: "admin.report",
      sample_account_ids: [reporter.id],
      report: { id: reportId, target_account: { id: target.id } },
    });

    const single = await json(`/api/v1/notifications/${only[0]?.id}`, {
      headers: await authHeaders("an-filter-admin@example.com", { admin: true }),
    });
    expect(read(NotificationSchema, single.body).report?.id).toBe(reportId);
  });
});

describe("admin sign-up notifications", () => {
  for (const approval of [false, true]) {
    it(`notifies admins of a sign-up ${approval ? "awaiting approval" : "without approval"}`, async () => {
      const adminEmail = `su-admin-${approval}@example.com`;
      await signedInAccount(adminEmail, { admin: true });
      await signedInAccount(`su-user-${approval}@example.com`);

      const created = await signUp(`newcomer${approval}`, approval);

      const listed = await notifications(adminEmail, { admin: true }, "?types[]=admin.sign_up");
      expect(listed.map((entry) => entry.account.id)).toEqual([created.id]);
      expect(listed[0]?.report).toBeUndefined();
      expect(await notifications(`su-user-${approval}@example.com`, {})).toEqual([]);
    });
  }

  it("does not tell a new admin about their own sign-up", async () => {
    const userId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role)
       VALUES (?, 'founder', 'founder@example.com', 1, ?, ?, 'admin')`,
    )
      .bind(userId, now, now)
      .run();
    const created = await createSignupAccount(
      env,
      { username: "founder", email: "founder@example.com" },
      userId,
    );
    expect(created.isOk()).toBe(true);
    expect(await notifications("founder@example.com", { admin: true })).toEqual([]);
  });
});
