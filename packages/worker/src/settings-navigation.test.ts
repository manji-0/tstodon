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
});
