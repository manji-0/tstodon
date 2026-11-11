import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  ApiAdminAccount,
  ApiAdminAnnouncement,
  ApiAdminCanonicalEmailBlock,
  ApiAdminCohort,
  ApiAdminDimension,
  ApiAdminIpBlock,
  ApiAdminMeasure,
  ApiAdminPreviewCardProvider,
  ApiAdminCustomEmoji,
  ApiAdminDomainAllow,
  ApiAdminDomainBlock,
  ApiAdminEmailDomainBlock,
  ApiAdminReport,
  ApiAdminTag,
  ApiCredentialAccount,
  ApiReport,
  ApiStatus,
  ApiTrendsLink,
} from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { answerLinkPreviews } from "../test/link-card-fixture";

/**
 * The admin API (`/api/v1/admin/*`) checked against its `@tstodon/api`
 * schemas (`REST::Admin::*`): each answer of the endpoints parses. Behaviour
 * is asserted in the `admin-*.test.ts` files.
 */

const ADMIN = "contract-admin@example.com";
const MEMBER = "contract-member@example.com";

const call = async (
  method: string,
  path: string,
  options: Readonly<{ email?: string; admin?: boolean; body?: unknown }> = {},
): Promise<Readonly<{ status: number; body: unknown }>> => {
  const email = options.email ?? ADMIN;
  const headers = await authHeaders(email, { admin: options.admin ?? email === ADMIN });
  const response = await SELF.fetch(`https://example.com${path}`, {
    method,
    headers:
      options.body === undefined ? headers : { "content-type": "application/json", ...headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json() };
};

const ok = async <T>(
  schema: z.ZodType<T>,
  method: string,
  path: string,
  options: Parameters<typeof call>[2] = {},
): Promise<T> => {
  const response = await call(method, path, options);
  expect(response.status, `${method} ${path}`).toBe(200);
  return expectContract(schema, response.body);
};

describe("admin API contract (@tstodon/api)", () => {
  it("accounts and reports", async () => {
    const member = await ok(ApiCredentialAccount, "GET", "/api/v1/accounts/verify_credentials", {
      email: MEMBER,
    });
    const status = await ok(ApiStatus, "POST", "/api/v1/statuses", {
      email: MEMBER,
      body: { status: "contract report target" },
    });

    const accounts = await ok(z.array(ApiAdminAccount), "GET", "/api/v1/admin/accounts");
    const listed = accounts.find((account) => account.id === member.id);
    // Mastodon nests the public account; the moderation fields sit beside it.
    expect(listed).toMatchObject({
      username: member.username,
      domain: null,
      email: MEMBER,
      account: { id: member.id, acct: member.acct },
    });
    await ok(z.array(ApiAdminAccount), "GET", "/api/v1/admin/accounts?origin=remote");
    await ok(ApiAdminAccount, "GET", `/api/v1/admin/accounts/${member.id}`);
    const silenced = await ok(
      ApiAdminAccount,
      "POST",
      `/api/v1/admin/accounts/${member.id}/silence`,
    );
    expect(silenced).toMatchObject({ silenced: true, limited: true });
    await ok(ApiAdminAccount, "POST", `/api/v1/admin/accounts/${member.id}/unsilence`);
    await ok(ApiAdminAccount, "POST", `/api/v1/admin/accounts/${member.id}/sensitize`);
    await ok(ApiAdminAccount, "POST", `/api/v1/admin/accounts/${member.id}/unsensitize`);

    const filed = await ok(ApiReport, "POST", "/api/v1/reports", {
      body: { account_id: member.id, status_ids: [status.id], comment: "contract" },
    });
    const reports = await ok(z.array(ApiAdminReport), "GET", "/api/v1/admin/reports");
    expect(reports.map((report) => report.id)).toContain(filed.id);
    const report = await ok(ApiAdminReport, "GET", `/api/v1/admin/reports/${filed.id}`);
    expect(report.target_account?.account.id).toBe(member.id);
    expect(report.statuses.map((reported) => reported.id)).toEqual([status.id]);
    const assigned = await ok(
      ApiAdminReport,
      "POST",
      `/api/v1/admin/reports/${filed.id}/assign_to_self`,
    );
    expect(assigned.assigned_account).not.toBeNull();
    await ok(ApiAdminReport, "POST", `/api/v1/admin/reports/${filed.id}/unassign`);
    const resolved = await ok(ApiAdminReport, "POST", `/api/v1/admin/reports/${filed.id}/resolve`);
    expect(resolved.action_taken_by_account).not.toBeNull();
    await ok(ApiAdminReport, "POST", `/api/v1/admin/reports/${filed.id}/reopen`);
    await ok(ApiAdminReport, "PUT", `/api/v1/admin/reports/${filed.id}`, {
      body: { category: "spam" },
    });
  });

  it("domain blocks and allows, email blocks", async () => {
    const block = await ok(ApiAdminDomainBlock, "POST", "/api/v1/admin/domain_blocks", {
      body: { domain: "contract-blocked.example", severity: "silence", public_comment: "spam" },
    });
    // Mastodon's `digest`: the SHA-256 of the domain, as the public list shows it.
    expect(block.digest).toMatch(/^[0-9a-f]{64}$/);
    await ok(z.array(ApiAdminDomainBlock), "GET", "/api/v1/admin/domain_blocks");
    await ok(ApiAdminDomainBlock, "GET", `/api/v1/admin/domain_blocks/${block.id}`);
    await ok(ApiAdminDomainBlock, "PUT", `/api/v1/admin/domain_blocks/${block.id}`, {
      body: { severity: "suspend", obfuscate: true },
    });
    await ok(z.object({}), "DELETE", `/api/v1/admin/domain_blocks/${block.id}`);

    const allow = await ok(ApiAdminDomainAllow, "POST", "/api/v1/admin/domain_allows", {
      body: { domain: "contract-allowed.example" },
    });
    await ok(z.array(ApiAdminDomainAllow), "GET", "/api/v1/admin/domain_allows");
    await ok(ApiAdminDomainAllow, "GET", `/api/v1/admin/domain_allows/${allow.id}`);
    await ok(z.object({}), "DELETE", `/api/v1/admin/domain_allows/${allow.id}`);

    const emailBlock = await ok(
      ApiAdminEmailDomainBlock,
      "POST",
      "/api/v1/admin/email_domain_blocks",
      { body: { domain: "contract-mail.example" } },
    );
    expect(emailBlock.history.length).toBeGreaterThan(0);
    await ok(z.array(ApiAdminEmailDomainBlock), "GET", "/api/v1/admin/email_domain_blocks");
    await ok(ApiAdminEmailDomainBlock, "GET", `/api/v1/admin/email_domain_blocks/${emailBlock.id}`);

    const canonical = await ok(
      ApiAdminCanonicalEmailBlock,
      "POST",
      "/api/v1/admin/canonical_email_blocks",
      { body: { email: "Blocked.Person+tag@contract-mail.example" } },
    );
    await ok(z.array(ApiAdminCanonicalEmailBlock), "GET", "/api/v1/admin/canonical_email_blocks");
    await ok(
      ApiAdminCanonicalEmailBlock,
      "GET",
      `/api/v1/admin/canonical_email_blocks/${canonical.id}`,
    );
    const tested = await ok(
      ApiAdminCanonicalEmailBlock,
      "POST",
      "/api/v1/admin/canonical_email_blocks/test",
      { body: { email: "Blocked.Person+tag@contract-mail.example" } },
    );
    expect(tested.id).toBe(canonical.id);
  });

  it("trends, announcements and custom emoji", async () => {
    const status = await ok(ApiStatus, "POST", "/api/v1/statuses", {
      email: MEMBER,
      body: { status: "trending #contracttrend https://example.com/contract-link" },
    });
    const tags = await ok(z.array(ApiAdminTag), "GET", "/api/v1/admin/trends/tags");
    const tag = tags.find((candidate) => candidate.name === "contracttrend");
    if (tag) {
      expect(tag.requires_review).toBe(true);
      await ok(ApiAdminTag, "POST", `/api/v1/admin/trends/tags/${tag.id}/approve`);
    }
    await ok(z.array(ApiTrendsLink), "GET", "/api/v1/admin/trends/links");
    await ok(z.array(ApiStatus), "GET", "/api/v1/admin/trends/statuses");
    await ok(ApiStatus, "POST", `/api/v1/admin/trends/statuses/${status.id}/approve`);
    await ok(ApiStatus, "POST", `/api/v1/admin/trends/statuses/${status.id}/reject`);

    const announcement = await ok(ApiAdminAnnouncement, "POST", "/api/v1/admin/announcements", {
      body: { text: "Contract maintenance" },
    });
    await ok(z.array(ApiAdminAnnouncement), "GET", "/api/v1/admin/announcements");
    const published = await ok(
      ApiAdminAnnouncement,
      "POST",
      `/api/v1/admin/announcements/${announcement.id}/publish`,
    );
    expect(published.published_at).not.toBeNull();
    await ok(z.array(ApiAdminCustomEmoji), "GET", "/api/v1/admin/custom_emojis");
  });

  it("IP blocks, tags, dashboard metrics, v2 accounts and link publishers", async () => {
    const block = await ok(ApiAdminIpBlock, "POST", "/api/v1/admin/ip_blocks", {
      body: { ip: "100.64.0.0/10", severity: "sign_up_requires_approval", comment: "contract" },
    });
    await ok(z.array(ApiAdminIpBlock), "GET", "/api/v1/admin/ip_blocks");
    await ok(ApiAdminIpBlock, "GET", `/api/v1/admin/ip_blocks/${block.id}`);
    await ok(ApiAdminIpBlock, "PUT", `/api/v1/admin/ip_blocks/${block.id}`, {
      body: { expires_in: 86400 },
    });
    await ok(z.object({}), "DELETE", `/api/v1/admin/ip_blocks/${block.id}`);

    // The status queues a preview of its link (see `answerLinkPreviews`).
    const previews = answerLinkPreviews(["https://contract-publisher.example/a"]);
    await ok(ApiStatus, "POST", "/api/v1/statuses", {
      email: MEMBER,
      body: { status: "contract #contractadmintag https://contract-publisher.example/a" },
    });
    await previews.settled();
    await ok(z.array(ApiAdminTag), "GET", "/api/v1/admin/tags");
    await ok(ApiAdminTag, "GET", "/api/v1/admin/tags/contractadmintag");
    await ok(ApiAdminTag, "PUT", "/api/v1/admin/tags/contractadmintag", {
      body: { usable: true, listable: true, trendable: true },
    });

    const range = { start_at: new Date().toISOString().slice(0, 10) };
    await ok(z.array(ApiAdminMeasure), "POST", "/api/v1/admin/measures", {
      body: { ...range, keys: ["new_users", "active_users", "instance_media_attachments"] },
    });
    await ok(z.array(ApiAdminDimension), "POST", "/api/v1/admin/dimensions", {
      body: { ...range, keys: ["languages", "space_usage", "software_versions"] },
    });
    await ok(z.array(ApiAdminCohort), "POST", "/api/v1/admin/retention", {
      body: { ...range, frequency: "day" },
    });

    await ok(z.array(ApiAdminAccount), "GET", "/api/v2/admin/accounts?status=active");
    await ok(z.array(ApiAdminPreviewCardProvider), "GET", "/api/v1/admin/trends/links/publishers");
    await ok(
      ApiAdminPreviewCardProvider,
      "POST",
      "/api/v1/admin/trends/links/publishers/contract-publisher.example/approve",
    );
  });
});
