import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { ApiAdminDomainBlock, ApiAdminExistingDomainBlockError } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { adminBrowser, page } from "../test/admin-browser";
import { authHeaders } from "../test/auth-fixture";
import { postForm } from "../test/passkey-browser";
import { RemoteAccountId } from "./remote-account-id";

/**
 * Mastodon v4.7.5's `Api::V1::Admin::DomainBlocksController#create` and
 * `Admin::DomainBlocksController#create` look up `DomainBlock.rule_for(domain)`
 * and refuse a block the rule found already covers at least as strictly.
 */

const ADMIN = "domain-conflicts-admin@example.com";

const call = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<Readonly<{ status: number; body: unknown }>> => {
  const headers = await authHeaders(ADMIN, { admin: true });
  const response = await SELF.fetch(`https://example.com${path}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
};

const create = (body: Record<string, unknown>) => call("POST", "/api/v1/admin/domain_blocks", body);

const created = async (body: Record<string, unknown>) => {
  const answer = await create(body);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return expectContract(ApiAdminDomainBlock, answer.body);
};

const refused = async (body: Record<string, unknown>) => {
  const answer = await create(body);
  expect(answer.status).toBe(422);
  return expectContract(ApiAdminExistingDomainBlockError, answer.body);
};

describe("POST /api/v1/admin/domain_blocks under an existing rule", () => {
  it("refuses a block a parent domain's suspension already covers, naming that block", async () => {
    const parent = await created({ domain: "suspended-parent.example", severity: "suspend" });
    const error = await refused({ domain: "sub.suspended-parent.example", severity: "silence" });
    expect(error).toEqual({
      error: "You have already imposed stricter limits on suspended-parent.example.",
      existing_domain_block: parent,
    });
    expect(
      (await refused({ domain: "a.b.suspended-parent.example", severity: "noop" }))
        .existing_domain_block.id,
    ).toBe(parent.id);
  });

  it("creates a stricter block under a parent's rule", async () => {
    await created({ domain: "silenced-parent.example", severity: "silence" });
    const child = await created({ domain: "sub.silenced-parent.example", severity: "suspend" });
    expect(child).toMatchObject({ domain: "sub.silenced-parent.example", severity: "suspend" });
    // The most specific rule is the one compared: a suspension now covers this host.
    expect(
      (await refused({ domain: "deep.sub.silenced-parent.example", severity: "silence" }))
        .existing_domain_block.domain,
    ).toBe("sub.silenced-parent.example");
  });

  it("refuses dropping a parent's media or report rejection", async () => {
    await created({
      domain: "media-parent.example",
      severity: "silence",
      reject_media: true,
      reject_reports: true,
    });
    await refused({ domain: "a.media-parent.example", severity: "silence", reject_reports: true });
    await refused({ domain: "b.media-parent.example", severity: "silence", reject_media: true });
    await created({
      domain: "c.media-parent.example",
      severity: "silence",
      reject_media: true,
      reject_reports: true,
    });
  });

  it("refuses the same domain even when the new block is stricter, as REST does", async () => {
    const existing = await created({ domain: "twice.example", severity: "silence" });
    expect(await refused({ domain: "Twice.Example", severity: "suspend" })).toEqual({
      error: "You have already imposed stricter limits on twice.example.",
      existing_domain_block: existing,
    });
  });

  it("stores an internationalized domain in its ASCII form and matches it", async () => {
    const block = await created({ domain: "Bücher-Blocked.Example", severity: "silence" });
    expect(block.domain).toBe("xn--bcher-blocked-wob.example");
    expect(
      (await refused({ domain: "sub.bücher-blocked.example", severity: "noop" }))
        .existing_domain_block.id,
    ).toBe(block.id);
  });

  it("answers Mastodon's validation errors for a bad domain or severity", async () => {
    expect(await create({ domain: "foo bar", severity: "silence" })).toEqual({
      status: 422,
      body: expect.objectContaining({ error: "Validation failed: Domain is invalid" }),
    });
    expect(await create({ domain: "", severity: "silence" })).toEqual({
      status: 422,
      body: expect.objectContaining({ error: "Validation failed: Domain can't be blank" }),
    });
    expect(await create({ domain: "bad-severity.example", severity: "bar" })).toEqual({
      status: 422,
      body: expect.objectContaining({
        error: "Validation failed: Severity is not included in the list",
      }),
    });
    // `enum :severity, validate: true` is declared before `validates :domain`.
    expect(await create({ domain: "", severity: "bar" })).toEqual({
      status: 422,
      body: expect.objectContaining({
        error: "Validation failed: Severity is not included in the list, Domain can't be blank",
      }),
    });
    expect(await create({ domain: "foo bar", severity: "bar" })).toEqual({
      status: 422,
      body: expect.objectContaining({
        error: "Validation failed: Severity is not included in the list, Domain is invalid",
      }),
    });
  });

  it("checks the covering rule before the validations, as Mastodon's create", async () => {
    const parent = await created({
      domain: "order-parent.example",
      severity: "suspend",
      reject_media: true,
    });
    // An unknown severity is compared by its rejections only: dropping the
    // parent's `reject_media` is the conflict answered first.
    expect(
      (await refused({ domain: "sub.order-parent.example", severity: "bar" })).existing_domain_block
        .id,
    ).toBe(parent.id);
    expect(
      await create({ domain: "sub.order-parent.example", severity: "bar", reject_media: true }),
    ).toEqual({
      status: 422,
      body: expect.objectContaining({
        error: "Validation failed: Severity is not included in the list",
      }),
    });
    expect(
      (await refused({ domain: "under_score.order-parent.example", severity: "silence" }))
        .existing_domain_block.id,
    ).toBe(parent.id);
  });

  it("updates a block under a stricter parent without comparing them, as Mastodon's update", async () => {
    const child = await created({ domain: "sub.later-parent.example", severity: "silence" });
    await created({ domain: "later-parent.example", severity: "suspend" });
    const updated = await call("PUT", `/api/v1/admin/domain_blocks/${child.id}`, {
      severity: "noop",
    });
    expect(updated.status).toBe(200);
    expect(expectContract(ApiAdminDomainBlock, updated.body).severity).toBe("noop");
    const invalid = await call("PUT", `/api/v1/admin/domain_blocks/${child.id}`, {
      severity: "bar",
    });
    expect(invalid).toEqual({
      status: 422,
      body: expect.objectContaining({
        error: "Validation failed: Severity is not included in the list",
      }),
    });
  });
});

describe("the admin pages under an existing rule", () => {
  it("refuses a block a parent's rule already covers, as Admin::DomainBlocksController#create", async () => {
    const admin = await adminBrowser("domain_conflicts_page_admin");
    await created({ domain: "page-parent.example", severity: "suspend" });
    const html = await page(
      await postForm(admin.fetcher, "/admin/instances/sub.page-parent.example", {
        do: "save",
        severity: "silence",
      }),
      422,
    );
    expect(html).toContain(
      "You have already imposed stricter limits on page-parent.example, you need to unblock it first.",
    );
    expect(html).toContain('href="/admin/instances/page-parent.example"');
  });

  it("shows a remote account's domain rule as Admin::AccountsController#show does", async () => {
    const admin = await adminBrowser("domain_conflicts_account_admin");
    await created({ domain: "account-parent.example", severity: "silence" });
    const covered = await page(
      await admin.fetcher(
        `/admin/accounts/${RemoteAccountId.encode("https://sub.account-parent.example/users/alice")}`,
      ),
    );
    expect(covered).toContain(
      '<a href="/admin/instances/sub.account-parent.example">View domain block</a>',
    );
    expect(covered).not.toContain("Add new domain block");

    const open = await page(
      await admin.fetcher(
        `/admin/accounts/${RemoteAccountId.encode("https://open-host.example/users/bob")}`,
      ),
    );
    expect(open).toContain(
      '<a href="/admin/instances/open-host.example">View summary for domain</a>',
    );
    expect(open).toContain(
      '<a href="/admin/instances/open-host.example#new-domain-block">Add new domain block</a>',
    );
    const form = await page(await admin.fetcher("/admin/instances/open-host.example"));
    expect(form).toContain('id="new-domain-block"');
  });
});
