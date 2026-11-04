import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ORIGIN, postForm, read, signUp } from "../test/passkey-browser";

const page = async (response: Response, status = 200): Promise<string> => {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("text/html");
  return response.text();
};

const LookupSchema = z.object({
  locked: z.boolean(),
  discoverable: z.boolean().nullable(),
  indexable: z.boolean(),
  hide_collections: z.boolean().nullable(),
});

const lookup = async (username: string) => {
  const response = await SELF.fetch(`${ORIGIN}/api/v1/accounts/lookup?acct=${username}`);
  expect(response.status).toBe(200);
  return read(LookupSchema, await response.json());
};

describe("settings pages the web app links to", () => {
  it("sends a signed-out browser to sign in, back to the page it asked for", async () => {
    for (const path of [
      "/settings/preferences",
      "/settings/preferences/posting_defaults",
      "/settings/privacy",
    ]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `/auth/sign_in?return_to=${encodeURIComponent(path)}`,
      );
    }
  });

  it("keeps the page's query in return_to and off the sign-in page", async () => {
    const response = await SELF.fetch(`${ORIGIN}/admin/reports?resolved=1`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/auth/sign_in");
    expect([...location.searchParams.keys()]).toEqual(["return_to"]);
    expect(location.searchParams.get("return_to")).toBe("/admin/reports?resolved=1");
  });

  it("redirects /settings and /settings/profile to the pages that do their job", async () => {
    const settings = await SELF.fetch(`${ORIGIN}/settings`, { redirect: "manual" });
    expect(settings.status).toBe(302);
    expect(settings.headers.get("location")).toBe("/settings/preferences");
    const profile = await SELF.fetch(`${ORIGIN}/settings/profile`, { redirect: "manual" });
    expect(profile.status).toBe(302);
    expect(profile.headers.get("location")).toBe("/profile/edit");
  });

  it("lists the settings this server has, account migration included", async () => {
    const { fetcher } = await signUp("prefs_index");
    const html = await page(await fetcher("/settings/preferences"));
    expect(html).toContain("@prefs_index");
    for (const href of [
      "/profile/edit",
      "/settings/privacy",
      "/settings/preferences/posting_defaults",
      "/settings/aliases",
      "/settings/migration",
      "/mutes",
      "/blocks",
      "/filters",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(await page(await fetcher("/settings/aliases"))).toContain(
      'href="/settings/preferences"',
    );
  });

  it("saves posting defaults and shows them on the next visit", async () => {
    const { fetcher } = await signUp("prefs_posting");
    const before = await page(await fetcher("/settings/preferences/posting_defaults"));
    expect(before).toContain('<option value="public" selected>');

    const saved = await page(
      await postForm(fetcher, "/settings/preferences/posting_defaults", {
        privacy: "private",
        quote_policy: "nobody",
        language: "ja",
        sensitive: "1",
      }),
    );
    expect(saved).toContain("Changes saved.");
    const after = await page(await fetcher("/settings/preferences/posting_defaults"));
    expect(after).toContain('<option value="private" selected>');
    expect(after).toContain('<option value="nobody" selected>');
    expect(after).toContain('<option value="ja" selected>');
    expect(after).toMatch(/id="sensitive" name="sensitive" value="1" checked/);

    const cleared = await page(
      await postForm(fetcher, "/settings/preferences/posting_defaults", {
        privacy: "public",
        quote_policy: "public",
        language: "",
      }),
    );
    expect(cleared).toContain('<option value="" selected>');
    expect(cleared).not.toMatch(/id="sensitive" name="sensitive" value="1" checked/);

    const refused = await postForm(fetcher, "/settings/preferences/posting_defaults", {
      privacy: "private",
      quote_policy: "public",
      language: "klingon",
    });
    expect(await page(refused, 422)).toContain('<option value="public" selected>');
  });

  it("saves privacy and reach as the account API reports it", async () => {
    const { fetcher } = await signUp("prefs_privacy");
    const before = await page(await fetcher("/settings/privacy"));
    expect(before).toContain('id="account_unlocked" name="account_unlocked" value="1" checked');
    expect(before).toContain('id="account_discoverable"');

    const saved = await postForm(fetcher, "/settings/privacy", { account_discoverable: "1" });
    expect(await page(saved)).toContain("Changes saved.");
    expect(await lookup("prefs_privacy")).toEqual({
      locked: true,
      discoverable: true,
      indexable: false,
      hide_collections: true,
    });

    await postForm(fetcher, "/settings/privacy", {
      account_unlocked: "1",
      account_indexable: "1",
      account_show_collections: "1",
    });
    expect(await lookup("prefs_privacy")).toEqual({
      locked: false,
      discoverable: false,
      indexable: true,
      hide_collections: false,
    });
  });

  it("refuses a settings form posted from another site", async () => {
    const { fetcher } = await signUp("prefs_cross_site");
    const crossSite = await fetcher("/settings/privacy", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
      },
      body: "",
    });
    expect(crossSite.status).toBe(403);
    expect((await lookup("prefs_cross_site")).locked).toBe(false);
  });

  it("accepts a form posted from its own page, which sends Origin: null", async () => {
    // The pages set `referrer: no-referrer`, so a browser's form post carries
    // `Origin: null` and only Sec-Fetch-Site says where it came from.
    const { fetcher } = await signUp("prefs_same_site");
    const sameSite = await fetcher("/settings/privacy", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
        origin: "null",
      },
      body: "",
    });
    expect(await page(sameSite)).toContain("Changes saved.");
    expect((await lookup("prefs_same_site")).locked).toBe(true);
  });

  it("explains the Rails pages this server does not have", async () => {
    for (const [path, title] of [
      ["/auth/edit", "Password and security"],
      ["/settings/export", "Import and export"],
      ["/admin/software_updates", "Administration"],
      ["/admin/tags/3", "Administration"],
      ["/severed_relationships", "Severed relationships"],
      ["/disputes/strikes/3", "Moderation decisions"],
      ["/settings/applications", "Settings"],
    ] as const) {
      const html = await page(
        await SELF.fetch(`${ORIGIN}${path}`, { headers: { accept: "text/html" } }),
      );
      expect(html, path).toContain(`<h1>${title}</h1>`);
      expect(html, path).toContain("This page is not available on this server.");
      expect(html, path).toContain('href="/settings/preferences"');
    }
  });
});
