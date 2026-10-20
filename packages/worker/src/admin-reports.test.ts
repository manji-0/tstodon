import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { MastodonAccountPreviewSchema } from "./schemas";

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

const ReportSchema = z.object({
  id: z.string().min(1),
  action_taken: z.boolean(),
  action_taken_at: z.string().nullable(),
  category: z.string().min(1),
  comment: z.string(),
  forwarded: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  account: MastodonAccountPreviewSchema.nullable(),
  target_account: MastodonAccountPreviewSchema.nullable(),
  assigned_account: MastodonAccountPreviewSchema.nullable(),
  action_taken_by_account: MastodonAccountPreviewSchema.nullable(),
  statuses: z.array(z.object({ id: z.string().min(1) })),
  rules: z.array(z.object({ id: z.string(), text: z.string(), hint: z.string().optional() })),
});

/** `POST /api/v1/reports` answers Mastodon's plain Report entity. */
const CreatedReportSchema = z.object({
  id: z.string().min(1),
  action_taken: z.boolean(),
  action_taken_at: z.string().nullable(),
  category: z.string().min(1),
  comment: z.string(),
  forwarded: z.boolean(),
  status_ids: z.array(z.string()),
  rule_ids: z.array(z.string()),
  target_account: z.object({ id: z.string().min(1) }),
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

const fileReport = async (
  email: string,
  targetId: string,
  body: Record<string, unknown> = {},
): Promise<z.infer<typeof CreatedReportSchema>> => {
  const response = await json("/api/v1/reports", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify({ account_id: targetId, ...body }),
  });
  expect(response.status).toBe(200);
  return read(CreatedReportSchema, response.body);
};

const reportWithRules = async (email: string, targetId: string) => {
  const response = await json("/api/v1/reports", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify({ account_id: targetId, category: "violation", rule_ids: ["2"] }),
  });
  expect(response.status).toBe(200);
  const created = read(CreatedReportSchema, response.body);
  expect(created.rule_ids).toEqual(["2"]);
  return created;
};

const adminReports = async (email: string, query = ""): Promise<z.infer<typeof ReportSchema>[]> => {
  const response = await json(`/api/v1/admin/reports${query}`, {
    headers: await auth(email, { admin: true }),
  });
  expect(response.status).toBe(200);
  return read(z.array(ReportSchema), response.body);
};

describe("admin reports", () => {
  it("lists reports with the documented filters and resolution", async () => {
    const admin = "reports-admin@example.com";
    const reporter = "reports-reporter@example.com";
    const target = await credentials("reports-target@example.com");
    const otherTarget = await credentials("reports-target2@example.com");

    const first = await fileReport(reporter, target.id, {
      comment: "bad behaviour",
      category: "spam",
    });
    expect(first.category).toBe("spam");
    expect(first.action_taken).toBe(false);
    expect(first.target_account.id).toBe(target.id);

    const second = await fileReport(reporter, otherTarget.id);
    expect(second.category).toBe("other");

    // The list is newest first, and the filters narrow it.
    const all = await adminReports(admin);
    expect(all.map((report) => report.id).slice(0, 2)).toEqual([second.id, first.id]);
    expect((await adminReports(admin, `?target_account_id=${target.id}`)).map((r) => r.id)).toEqual(
      [first.id],
    );
    const reporterAccount = await credentials(reporter);
    expect((await adminReports(admin, `?account_id=${reporterAccount.id}`)).length).toBe(2);

    const resolved = await json(`/api/v1/admin/reports/${first.id}/resolve`, {
      method: "POST",
      headers: await auth(admin, { admin: true }),
    });
    expect(resolved.status).toBe(200);
    const document = read(ReportSchema, resolved.body);
    expect(document.action_taken).toBe(true);
    expect(document.action_taken_at).not.toBeNull();
    expect(document.action_taken_by_account?.id).toBeDefined();

    expect((await adminReports(admin, "?resolved=true")).map((r) => r.id)).toEqual([first.id]);
    expect((await adminReports(admin, "?resolved=false")).map((r) => r.id)).toContain(second.id);
    expect((await adminReports(admin, "?resolved=false")).map((r) => r.id)).not.toContain(first.id);

    // Reopening clears the resolution again.
    const reopened = await json(`/api/v1/admin/reports/${first.id}/reopen`, {
      method: "POST",
      headers: await auth(admin, { admin: true }),
    });
    expect(reopened.status).toBe(200);
    expect(read(ReportSchema, reopened.body).action_taken).toBe(false);
  });

  it("serves a single report and 404s for an unknown one", async () => {
    const admin = "reports2-admin@example.com";
    const target = await credentials("reports2-target@example.com");
    const filed = await fileReport("reports2-reporter@example.com", target.id);

    const one = await json(`/api/v1/admin/reports/${filed.id}`, {
      headers: await auth(admin, { admin: true }),
    });
    expect(one.status).toBe(200);
    expect(read(ReportSchema, one.body).id).toBe(filed.id);

    const missing = await json("/api/v1/admin/reports/nope", {
      headers: await auth(admin, { admin: true }),
    });
    expect(missing.status).toBe(404);
    // The endpoints are admin only.
    expect((await json(`/api/v1/admin/reports/${filed.id}`)).status).toBe(401);
  });

  it("rejects an unknown report category", async () => {
    const target = await credentials("reports3-target@example.com");
    const response = await json("/api/v1/reports", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await auth("reports3-reporter@example.com")),
      },
      body: JSON.stringify({ account_id: target.id, category: "rude" }),
    });
    expect(response.status).toBe(422);
  });

  it("updates the category and rules, and assigns the report", async () => {
    const admin = "reports4-admin@example.com";
    const target = await credentials("reports4-target@example.com");
    const filed = await reportWithRules("reports4-reporter@example.com", target.id);

    // The configured INSTANCE_RULES carry ids 1..2; a violation may cite them.
    const updated = await json(`/api/v1/admin/reports/${filed.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(admin, { admin: true })) },
      body: JSON.stringify({ category: "violation", rule_ids: ["1"] }),
    });
    expect(updated.status).toBe(200);
    const document = read(ReportSchema, updated.body);
    expect(document.category).toBe("violation");
    expect(document.rules.map((rule) => rule.id)).toEqual(["1"]);

    // Rules are only meaningful for a violation, and must exist.
    const wrongCategory = await json(`/api/v1/admin/reports/${filed.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(admin, { admin: true })) },
      body: JSON.stringify({ category: "spam", rule_ids: ["1"] }),
    });
    expect(wrongCategory.status).toBe(422);
    const unknownRule = await json(`/api/v1/admin/reports/${filed.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(admin, { admin: true })) },
      body: JSON.stringify({ rule_ids: ["99"] }),
    });
    expect(unknownRule.status).toBe(422);
    const badCategory = await json(`/api/v1/admin/reports/${filed.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(admin, { admin: true })) },
      body: JSON.stringify({ category: "rude" }),
    });
    expect(badCategory.status).toBe(422);

    // Assignment names the moderator and unassign clears it.
    const assigned = await json(`/api/v1/admin/reports/${filed.id}/assign_to_self`, {
      method: "POST",
      headers: await auth(admin, { admin: true }),
    });
    expect(assigned.status).toBe(200);
    expect(read(ReportSchema, assigned.body).assigned_account?.id).toBeDefined();
    const unassigned = await json(`/api/v1/admin/reports/${filed.id}/unassign`, {
      method: "POST",
      headers: await auth(admin, { admin: true }),
    });
    expect(read(ReportSchema, unassigned.body).assigned_account).toBeNull();
  });

  it("resolves the report behind a moderation action", async () => {
    const admin = "reports5-admin@example.com";
    const target = await credentials("reports5-target@example.com");
    const first = await fileReport("reports5-reporter@example.com", target.id);
    const second = await fileReport("reports5-reporter@example.com", target.id);

    // A named report resolves only that one.
    const action = await json(`/api/v1/admin/accounts/${target.id}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(admin, { admin: true })) },
      body: JSON.stringify({ type: "silence", report_id: first.id }),
    });
    expect(action.status).toBe(200);
    const afterFirst = await json("/api/v1/admin/reports?resolved=true", {
      headers: await auth(admin, { admin: true }),
    });
    expect(read(z.array(ReportSchema), afterFirst.body).map((report) => report.id)).toEqual([
      first.id,
    ]);

    // Without a report id every open report against the account is resolved.
    const bulk = await json(`/api/v1/admin/accounts/${target.id}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(admin, { admin: true })) },
      body: JSON.stringify({ type: "none" }),
    });
    expect(bulk.status).toBe(200);
    const afterBulk = await json("/api/v1/admin/reports?resolved=true", {
      headers: await auth(admin, { admin: true }),
    });
    expect(read(z.array(ReportSchema), afterBulk.body).map((report) => report.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );

    // An unknown report id is a 404.
    const missing = await json(`/api/v1/admin/accounts/${target.id}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(admin, { admin: true })) },
      body: JSON.stringify({ type: "none", report_id: "nope" }),
    });
    expect(missing.status).toBe(404);
  });

  it("refuses to keep rules on a report that is no longer a violation", async () => {
    const admin = "reports6-admin@example.com";
    const target = await credentials("reports6-target@example.com");
    const filed = await reportWithRules("reports6-reporter@example.com", target.id);

    // Changing the category away from violation without clearing them is 422.
    const kept = await json(`/api/v1/admin/reports/${filed.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(admin, { admin: true })) },
      body: JSON.stringify({ category: "spam" }),
    });
    expect(kept.status).toBe(422);
    // Clearing them explicitly is accepted.
    const cleared = await json(`/api/v1/admin/reports/${filed.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(admin, { admin: true })) },
      body: JSON.stringify({ category: "spam", rule_ids: [] }),
    });
    expect(cleared.status).toBe(200);
    const document = read(ReportSchema, cleared.body);
    expect(document.category).toBe("spam");
    expect(document.rules).toEqual([]);
  });
});
