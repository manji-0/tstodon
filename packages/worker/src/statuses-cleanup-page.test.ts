import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { ORIGIN, postForm, signUp } from "../test/passkey-browser";
import { findStatusesCleanupPolicy } from "./statuses-cleanup-store";

const page = async (response: Response, status = 200): Promise<string> => {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("text/html");
  return response.text();
};

describe("/statuses_cleanup", () => {
  it("sends a signed-out browser to sign in, back to the page", async () => {
    const response = await SELF.fetch(`${ORIGIN}/statuses_cleanup`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `/auth/sign_in?return_to=${encodeURIComponent("/statuses_cleanup")}`,
    );
  });

  it("is linked from the preferences index", async () => {
    const { fetcher } = await signUp("cleanup_index");
    expect(await page(await fetcher("/settings/preferences"))).toContain(
      'href="/statuses_cleanup"',
    );
  });

  it("shows Mastodon's defaults before anything is saved", async () => {
    const { fetcher } = await signUp("cleanup_defaults");
    const html = await page(await fetcher("/statuses_cleanup"));
    expect(html).not.toMatch(/id="enabled" name="enabled" value="1" checked/);
    expect(html).toContain('<option value="1209600" selected>2 weeks</option>');
    expect(html).toMatch(/id="keep_pinned" name="keep_pinned" value="1" checked/);
    expect(html).toMatch(/id="keep_direct" name="keep_direct" value="1" checked/);
    expect(html).not.toMatch(/id="keep_polls" name="keep_polls" value="1" checked/);
  });

  it("saves the policy and shows it on the next visit", async () => {
    const { fetcher } = await signUp("cleanup_save");
    const saved = await page(
      await postForm(fetcher, "/statuses_cleanup", {
        enabled: "1",
        min_status_age: "15778476",
        keep_polls: "1",
        keep_media: "1",
        min_favs: "5",
        min_reblogs: "",
      }),
    );
    expect(saved).toContain("Changes saved.");

    const after = await page(await fetcher("/statuses_cleanup"));
    expect(after).toMatch(/id="enabled" name="enabled" value="1" checked/);
    expect(after).toContain('<option value="15778476" selected>6 months</option>');
    expect(after).toMatch(/id="keep_polls" name="keep_polls" value="1" checked/);
    expect(after).toMatch(/id="keep_media" name="keep_media" value="1" checked/);
    // Unchecked boxes were posted as absent, so they are off now.
    expect(after).not.toMatch(/id="keep_pinned" name="keep_pinned" value="1" checked/);
    expect(after).toContain(
      'id="min_favs" name="min_favs" inputmode="numeric" pattern="[0-9]*" value="5"',
    );
    expect(after).toContain(
      'id="min_reblogs" name="min_reblogs" inputmode="numeric" pattern="[0-9]*" value=""',
    );

    const off = await page(
      await postForm(fetcher, "/statuses_cleanup", { min_status_age: "604800" }),
    );
    expect(off).not.toMatch(/id="enabled" name="enabled" value="1" checked/);
    expect(off).toContain('<option value="604800" selected>1 week</option>');
  });

  it("refuses an age or count the form does not offer", async () => {
    const { fetcher } = await signUp("cleanup_invalid");
    const badAge = await page(
      await postForm(fetcher, "/statuses_cleanup", { enabled: "1", min_status_age: "12345" }),
      422,
    );
    expect(badAge).toContain("Choose an age from the list");
    const badCount = await page(
      await postForm(fetcher, "/statuses_cleanup", {
        enabled: "1",
        min_status_age: "604800",
        min_favs: "many",
      }),
      422,
    );
    expect(badCount).toContain("whole numbers");
    // Nothing was saved by either request.
    const account = await env.DB.prepare(
      "SELECT account_id FROM statuses_cleanup_policies WHERE enabled = 1 AND min_status_age = 604800",
    ).first();
    expect(account).toBeNull();
  });

  it("refuses a cross-site post and saves nothing", async () => {
    const { fetcher } = await signUp("cleanup_csrf");
    const refused = await fetcher("/statuses_cleanup", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
      body: new URLSearchParams({ enabled: "1", min_status_age: "604800" }).toString(),
    });
    await page(refused, 403);
    const html = await page(await fetcher("/statuses_cleanup"));
    expect(html).not.toMatch(/id="enabled" name="enabled" value="1" checked/);
  });

  it("reads back through the store the job uses", async () => {
    const { fetcher } = await signUp("cleanup_store");
    await postForm(fetcher, "/statuses_cleanup", {
      enabled: "1",
      min_status_age: "2629746",
      keep_self_fav: "1",
      min_reblogs: "3",
    });
    const row = await env.DB.prepare(
      "SELECT account_id FROM statuses_cleanup_policies WHERE min_status_age = 2629746",
    ).first<{ account_id: string }>();
    expect(row).not.toBeNull();
    const policy = await findStatusesCleanupPolicy(env.DB, row?.account_id ?? "");
    expect(policy.isOk() && policy.value).toEqual({
      kind: "Enabled",
      rules: {
        minAgeSeconds: 2629746,
        keepPinned: false,
        keepDirect: false,
        keepSelfFavourited: true,
        keepSelfBookmarked: false,
        keepPolls: false,
        keepMedia: false,
        keepFavourites: { kind: "Off" },
        keepBoosts: { kind: "AtLeast", count: 3 },
      },
    });
  });
});
