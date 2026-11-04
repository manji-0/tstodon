import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { authHeaders } from "../test/auth-fixture";
import { RemoteAccountId } from "./remote-account-id";
import { type Browser, ORIGIN, postForm, read, signUp } from "../test/passkey-browser";

const page = async (response: Response, status = 200): Promise<string> => {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("text/html");
  return response.text();
};

const redirectsTo = (response: Response, location: string) => {
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(location);
};

const api = async (path: string, headers: Record<string, string>, init: RequestInit = {}) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
  });
  expect(response.status, path).toBe(200);
  return response.json();
};

const IdSchema = z.object({ id: z.string().min(1) });

const AdminReportSchema = z.object({
  id: z.string(),
  action_taken: z.boolean(),
  assigned_account: IdSchema.nullable(),
  action_taken_by_account: IdSchema.nullable(),
});

const AdminAccountSchema = z.object({
  id: z.string(),
  approved: z.boolean(),
  disabled: z.boolean(),
  silenced: z.boolean(),
  suspended: z.boolean(),
  sensitized: z.boolean(),
});

const DomainBlockSchema = z.object({
  id: z.string(),
  domain: z.string(),
  severity: z.string(),
  reject_media: z.boolean(),
  reject_reports: z.boolean(),
  obfuscate: z.boolean(),
  public_comment: z.string().nullable(),
  private_comment: z.string().nullable(),
});

/** A signed-in browser whose Better Auth user has the admin role. */
const adminBrowser = async (username: string): Promise<{ fetcher: Browser; id: string }> => {
  const { fetcher } = await signUp(username);
  await env.DB.prepare(
    `UPDATE "user" SET role = 'admin' WHERE id = (SELECT auth_user_id FROM accounts WHERE username = ?)`,
  )
    .bind(username)
    .run();
  const lookup = await SELF.fetch(`${ORIGIN}/api/v1/accounts/lookup?acct=${username}`);
  return { fetcher, id: read(IdSchema, await lookup.json()).id };
};

const accountOf = async (email: string) => {
  const headers = await authHeaders(email);
  return {
    headers,
    id: read(IdSchema, await api("/api/v1/accounts/verify_credentials", headers)).id,
  };
};

/** A report against `targetEmail`'s account, with one of its posts attached. */
const fileReport = async (reporterEmail: string, targetEmail: string, comment: string) => {
  const target = await accountOf(targetEmail);
  const status = read(
    IdSchema,
    await api("/api/v1/statuses", target.headers, {
      method: "POST",
      body: JSON.stringify({ status: `post by ${targetEmail}` }),
    }),
  );
  const report = read(
    IdSchema,
    await api("/api/v1/reports", await authHeaders(reporterEmail), {
      method: "POST",
      body: JSON.stringify({
        account_id: target.id,
        status_ids: [status.id],
        comment,
        category: "spam",
      }),
    }),
  );
  return { reportId: report.id, targetId: target.id };
};

const adminApi = () => authHeaders("pages-api-admin@example.com", { admin: true });

const apiReport = async (id: string) =>
  read(AdminReportSchema, await api(`/api/v1/admin/reports/${id}`, await adminApi()));

const apiAccount = async (id: string) =>
  read(AdminAccountSchema, await api(`/api/v1/admin/accounts/${id}`, await adminApi()));

const apiDomainBlocks = async () =>
  read(z.array(DomainBlockSchema), await api("/api/v1/admin/domain_blocks", await adminApi()));

describe("admin pages", () => {
  it("sends a signed-out browser to sign in, back to the page it asked for", async () => {
    for (const path of [
      "/admin/reports",
      "/admin/reports/1",
      "/admin/accounts",
      "/admin/accounts/1",
      "/admin/instances",
      "/admin/instances/remote.example",
    ]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`, { redirect: "manual" });
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe(
        `/auth/sign_in?return_to=${encodeURIComponent(path)}`,
      );
    }
  });

  it("opens the reports from /admin and /admin/dashboard", async () => {
    for (const path of ["/admin", "/admin/dashboard"]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`, { redirect: "manual" });
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe("/admin/reports");
    }
  });

  it("refuses a signed-in user who is not an admin, on pages and on form posts", async () => {
    const { fetcher } = await signUp("pages_not_admin");
    const { reportId, targetId } = await fileReport(
      "pages-na-reporter@example.com",
      "pages-na-target@example.com",
      "spam",
    );
    for (const path of [
      "/admin/reports",
      `/admin/reports/${reportId}`,
      "/admin/accounts",
      `/admin/accounts/${targetId}`,
      "/admin/instances",
      "/admin/instances/remote.example",
    ]) {
      expect(await page(await fetcher(path), 403), path).toContain("administrators");
    }
    for (const [path, fields] of [
      [`/admin/reports/${reportId}`, { do: "resolve" }],
      [`/admin/reports/${reportId}/action`, { type: "suspend", confirmed: "1" }],
      [`/admin/accounts/${targetId}`, { do: "silence" }],
      ["/admin/instances/na.example", { do: "save", severity: "suspend" }],
    ] as const) {
      expect((await postForm(fetcher, path, fields)).status, path).toBe(403);
    }
    expect((await apiReport(reportId)).action_taken).toBe(false);
    expect(await apiAccount(targetId)).toMatchObject({ silenced: false, suspended: false });
    expect((await apiDomainBlocks()).map((block) => block.domain)).not.toContain("na.example");
  });

  it("lists open reports and resolves, reopens, and assigns one through the API's store", async () => {
    const admin = await adminBrowser("pages_reports_admin");
    const { reportId, targetId } = await fileReport(
      "pages-list-reporter@example.com",
      "pages-list-target@example.com",
      "This account posts spam links.",
    );
    const list = await page(await admin.fetcher("/admin/reports"));
    expect(list).toContain(`href="/admin/reports/${reportId}"`);
    expect(list).toContain(`href="/admin/accounts/${targetId}"`);
    expect(list).toContain("This account posts spam links.");
    expect(list).toContain("spam · 1 post · unassigned");

    const details = await page(await admin.fetcher(`/admin/reports/${reportId}`));
    expect(details).toContain("post by pages-list-target@example.com");
    expect(details).toContain("Mark as resolved");

    redirectsTo(
      await postForm(admin.fetcher, `/admin/reports/${reportId}`, { do: "assign_to_self" }),
      `/admin/reports/${reportId}?notice=assigned`,
    );
    expect((await apiReport(reportId)).assigned_account?.id).toBe(admin.id);
    redirectsTo(
      await postForm(admin.fetcher, `/admin/reports/${reportId}`, { do: "resolve" }),
      `/admin/reports/${reportId}?notice=resolved`,
    );
    expect(await apiReport(reportId)).toMatchObject({
      action_taken: true,
      action_taken_by_account: { id: admin.id },
    });
    expect(await page(await admin.fetcher("/admin/reports"))).not.toContain(
      `href="/admin/reports/${reportId}"`,
    );
    expect(await page(await admin.fetcher("/admin/reports?resolved=1"))).toContain(
      `href="/admin/reports/${reportId}"`,
    );
    expect(await page(await admin.fetcher(`/admin/reports/${reportId}?notice=resolved`))).toContain(
      "Report resolved.",
    );

    await postForm(admin.fetcher, `/admin/reports/${reportId}`, { do: "reopen" });
    await postForm(admin.fetcher, `/admin/reports/${reportId}`, { do: "unassign" });
    expect(await apiReport(reportId)).toMatchObject({
      action_taken: false,
      assigned_account: null,
    });
  });

  it("suspends the reported account after a confirmation, and resolves the report", async () => {
    const admin = await adminBrowser("pages_suspend_admin");
    const { reportId, targetId } = await fileReport(
      "pages-suspend-reporter@example.com",
      "pages-suspend-target@example.com",
      "abuse",
    );
    const confirm = await page(
      await postForm(admin.fetcher, `/admin/reports/${reportId}/action`, { type: "suspend" }),
    );
    expect(confirm).toContain('name="confirmed" value="1"');
    expect((await apiAccount(targetId)).suspended).toBe(false);

    redirectsTo(
      await postForm(admin.fetcher, `/admin/reports/${reportId}/action`, {
        type: "suspend",
        confirmed: "1",
      }),
      `/admin/reports/${reportId}?notice=actioned`,
    );
    expect((await apiAccount(targetId)).suspended).toBe(true);
    expect(await apiReport(reportId)).toMatchObject({
      action_taken: true,
      action_taken_by_account: { id: admin.id },
    });
  });

  it("marks the reported account's media sensitive without a confirmation", async () => {
    const admin = await adminBrowser("pages_sensitive_admin");
    const { reportId, targetId } = await fileReport(
      "pages-sensitive-reporter@example.com",
      "pages-sensitive-target@example.com",
      "nsfw",
    );
    redirectsTo(
      await postForm(admin.fetcher, `/admin/reports/${reportId}/action`, { type: "sensitive" }),
      `/admin/reports/${reportId}?notice=actioned`,
    );
    expect((await apiAccount(targetId)).sensitized).toBe(true);
    expect((await apiReport(reportId)).action_taken).toBe(true);
  });

  it("searches accounts and moderates one from its page", async () => {
    const admin = await adminBrowser("pages_accounts_admin");
    const target = await accountOf("pages-search-target@example.com");
    const other = await accountOf("pages-search-other@example.com");
    const found = await page(
      await admin.fetcher("/admin/accounts?username=search_target&status=active"),
    );
    expect(found).toContain(`href="/admin/accounts/${target.id}"`);
    expect(found).not.toContain(`href="/admin/accounts/${other.id}"`);
    expect(
      await page(await admin.fetcher(`/admin/accounts?email=pages-search-other@example.com`)),
    ).toContain(`href="/admin/accounts/${other.id}"`);

    const path = `/admin/accounts/${target.id}`;
    expect(await page(await admin.fetcher(path))).toContain("in good standing");
    redirectsTo(await postForm(admin.fetcher, path, { do: "silence" }), `${path}?notice=updated`);
    redirectsTo(await postForm(admin.fetcher, path, { do: "disable" }), `${path}?notice=updated`);
    expect(await apiAccount(target.id)).toMatchObject({ silenced: true, disabled: true });
    expect(await page(await admin.fetcher("/admin/accounts?status=silenced"))).toContain(
      `href="${path}"`,
    );

    expect(await page(await postForm(admin.fetcher, path, { do: "silence" }), 422)).toContain(
      "does not apply to this account now",
    );
    await postForm(admin.fetcher, path, { do: "unsilence" });
    await postForm(admin.fetcher, path, { do: "enable" });
    expect(await apiAccount(target.id)).toMatchObject({ silenced: false, disabled: false });

    expect(await page(await postForm(admin.fetcher, path, { do: "suspend" }))).toContain(
      'name="confirmed" value="1"',
    );
    expect((await apiAccount(target.id)).suspended).toBe(false);
    await postForm(admin.fetcher, path, { do: "suspend", confirmed: "1" });
    expect((await apiAccount(target.id)).suspended).toBe(true);
  });

  it("deletes an account only after a confirmation", async () => {
    const admin = await adminBrowser("pages_delete_admin");
    const target = await accountOf("pages-delete-target@example.com");
    const path = `/admin/accounts/${target.id}`;
    expect(await page(await postForm(admin.fetcher, path, { do: "delete" }))).toContain(
      "This cannot be undone.",
    );
    expect((await apiAccount(target.id)).id).toBe(target.id);
    redirectsTo(
      await postForm(admin.fetcher, path, { do: "delete", confirmed: "1" }),
      "/admin/accounts?notice=deleted",
    );
    const gone = await SELF.fetch(`${ORIGIN}/api/v1/admin/accounts/${target.id}`, {
      headers: await adminApi(),
    });
    expect(gone.status).toBe(404);
  });

  it("does not let an admin moderate their own account", async () => {
    const admin = await adminBrowser("pages_self_admin");
    const path = `/admin/accounts/${admin.id}`;
    expect(await page(await admin.fetcher(path))).toContain(
      "You cannot moderate your own account.",
    );
    expect(
      await page(await postForm(admin.fetcher, path, { do: "suspend", confirmed: "1" }), 422),
    ).toContain("You cannot moderate your own account.");
    expect((await apiAccount(admin.id)).suspended).toBe(false);
  });

  it("sends a remote account's admin link on to its server's page", async () => {
    const admin = await adminBrowser("pages_remote_admin");
    const id = RemoteAccountId.encode("https://remote.example/users/alice");
    const html = await page(await admin.fetcher(`/admin/accounts/${id}`));
    expect(html).toContain("https://remote.example/users/alice");
    expect(html).toContain('href="/admin/instances/remote.example"');
  });

  it("answers 404 for reports, accounts, and domain blocks that do not exist", async () => {
    const admin = await adminBrowser("pages_missing_admin");
    expect(await page(await admin.fetcher("/admin/reports/999999999"), 404)).toContain(
      "no such report",
    );
    expect(await page(await admin.fetcher("/admin/accounts/999999999"), 404)).toContain(
      "no such account",
    );
    expect(
      (await postForm(admin.fetcher, "/admin/reports/999999999", { do: "resolve" })).status,
    ).toBe(404);
    expect(
      (await postForm(admin.fetcher, "/admin/accounts/999999999", { do: "silence" })).status,
    ).toBe(404);
    expect(
      (await postForm(admin.fetcher, "/admin/instances/unblocked.example", { do: "remove" }))
        .status,
    ).toBe(404);
  });

  it("creates, changes, and removes a domain block that the admin API then reports", async () => {
    const admin = await adminBrowser("pages_domains_admin");
    redirectsTo(
      await admin.fetcher("/admin/instances?domain=https://Blocked.Example/about"),
      "/admin/instances/blocked.example",
    );
    const fresh = await page(await admin.fetcher("/admin/instances/blocked.example"));
    expect(fresh).toContain("does not block");

    redirectsTo(
      await postForm(admin.fetcher, "/admin/instances/blocked.example", {
        do: "save",
        severity: "silence",
        reject_media: "1",
        public_comment: "spam source",
        private_comment: "see report 12",
      }),
      "/admin/instances/blocked.example?notice=block_saved",
    );
    const created = (await apiDomainBlocks()).find((block) => block.domain === "blocked.example");
    expect(created).toMatchObject({
      severity: "silence",
      reject_media: true,
      reject_reports: false,
      obfuscate: false,
      public_comment: "spam source",
      private_comment: "see report 12",
    });
    expect(await page(await admin.fetcher("/admin/instances"))).toContain(
      'href="/admin/instances/blocked.example"',
    );

    await postForm(admin.fetcher, "/admin/instances/blocked.example", {
      do: "save",
      severity: "suspend",
      reject_reports: "1",
      obfuscate: "1",
    });
    expect((await apiDomainBlocks()).find((block) => block.domain === "blocked.example")).toEqual({
      ...created,
      severity: "suspend",
      reject_media: false,
      reject_reports: true,
      obfuscate: true,
      public_comment: null,
      private_comment: null,
    });

    redirectsTo(
      await postForm(admin.fetcher, "/admin/instances/blocked.example", { do: "remove" }),
      "/admin/instances?notice=block_removed",
    );
    expect((await apiDomainBlocks()).map((block) => block.domain)).not.toContain("blocked.example");
  });

  it("refuses to block this server's own domain", async () => {
    const admin = await adminBrowser("pages_own_domain_admin");
    expect(
      await page(
        await postForm(admin.fetcher, "/admin/instances/example.com", {
          do: "save",
          severity: "suspend",
        }),
        422,
      ),
    ).toContain("own domain");
  });

  it("refuses a cross-site form post", async () => {
    const admin = await adminBrowser("pages_cross_site_admin");
    const { reportId } = await fileReport(
      "pages-cs-reporter@example.com",
      "pages-cs-target@example.com",
      "spam",
    );
    const response = await admin.fetcher(`/admin/reports/${reportId}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
      },
      body: "do=resolve",
    });
    expect(response.status).toBe(403);
    expect((await apiReport(reportId)).action_taken).toBe(false);
  });

  it("links the administration from the preferences of admins only", async () => {
    const admin = await adminBrowser("pages_prefs_admin");
    expect(await page(await admin.fetcher("/settings/preferences"))).toContain(
      'href="/admin/reports"',
    );
    const { fetcher } = await signUp("pages_prefs_user");
    expect(await page(await fetcher("/settings/preferences"))).not.toContain("/admin/");
  });
});
