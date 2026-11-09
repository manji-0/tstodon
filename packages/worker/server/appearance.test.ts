import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { ORIGIN, postForm, signUp } from "../test/passkey-browser";
import { applyAppearance } from "./appearance";

const html = async (response: Response, status = 200): Promise<string> => {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("text/html");
  return response.text();
};

const htmlTag = (page: string): string => /<html[^>]*>/.exec(page)?.[0] ?? "";

const themeColors = (page: string): string[] =>
  [...page.matchAll(/<meta name="theme-color"[^>]*>/g)].map((match) => match[0]);

describe("appearance: color scheme and contrast", () => {
  it("renders the Worker's pages on auto, with the shared stylesheet, for a signed-out browser", async () => {
    const page = await html(await SELF.fetch(`${ORIGIN}/auth/sign_in`));
    expect(htmlTag(page)).toContain('data-color-scheme="auto"');
    expect(htmlTag(page)).toContain('data-contrast="auto"');
    expect(themeColors(page)).toHaveLength(2);
    expect(page).not.toContain("<style>");
    const href = /<link rel="stylesheet" href="([^"]+)"/.exec(page)?.[1] ?? "";
    expect(href).toMatch(/^\/packs\/assets\/pages-[\w-]{8}\.css$/);
    const sheet = await SELF.fetch(`${ORIGIN}${href}`);
    expect(sheet.status).toBe(200);
    expect(sheet.headers.get("content-type")).toContain("text/css");
    expect(sheet.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    const css = await sheet.text();
    // The web app's tokens: the app backgrounds and the accent.
    for (const token of ["#08090a", "#f7f8f8", "#5e6ad2", "--color-bg-app", "Inter"]) {
      expect(css).toContain(token);
    }
    expect(css).toContain("prefers-color-scheme:dark");
    expect(css).toContain("prefers-contrast:more");

    const shell = await html(await SELF.fetch(`${ORIGIN}/`));
    expect(htmlTag(shell)).toContain('data-color-scheme="auto"');
    expect(htmlTag(shell)).toContain('data-system-theme="true"');
  });

  it("saves the choice and renders it on the settings pages and the web app shell", async () => {
    const { fetcher } = await signUp("appearance_dark");
    const index = await html(await fetcher("/settings/preferences"));
    expect(index).toContain('<h2 id="appearance">Appearance</h2>');
    expect(index).toContain('action="/settings/preferences/appearance"');
    expect(index).toMatch(/name="color_scheme" value="auto" checked/);
    expect(index).toMatch(/name="contrast" value="auto" checked/);
    expect(htmlTag(index)).toContain('data-color-scheme="auto"');

    const saved = await html(
      await postForm(fetcher, "/settings/preferences/appearance", {
        color_scheme: "dark",
        contrast: "high",
      }),
    );
    expect(saved).toContain("Changes saved.");
    // The response that saved it already shows it.
    expect(htmlTag(saved)).toContain('data-color-scheme="dark"');
    expect(htmlTag(saved)).toContain('data-contrast="high"');
    expect(saved).toMatch(/name="color_scheme" value="dark" checked/);
    expect(saved).toMatch(/name="contrast" value="high" checked/);
    expect(themeColors(saved)).toEqual(['<meta name="theme-color" content="#08090a">']);
    expect(saved).toContain('<meta name="color-scheme" content="dark" />');

    for (const path of [
      "/settings/preferences",
      "/settings/preferences/posting_defaults",
      "/filters",
    ]) {
      const page = await html(await fetcher(path));
      expect(htmlTag(page), path).toContain('data-color-scheme="dark"');
      expect(htmlTag(page), path).toContain('data-contrast="high"');
    }

    const shell = await html(await fetcher("/home"));
    expect(htmlTag(shell)).toContain('data-color-scheme="dark"');
    expect(htmlTag(shell)).toContain('data-contrast="high"');
    expect(htmlTag(shell)).not.toContain("data-system-theme");
    expect(themeColors(shell)).toEqual(['<meta name="theme-color" content="#08090a">']);

    const row = await env.DB.prepare(
      "SELECT p.color_scheme, p.contrast FROM account_appearance p JOIN accounts a ON a.id = p.account_id WHERE a.username = 'appearance_dark'",
    ).first();
    expect(row).toEqual({ color_scheme: "dark", contrast: "high" });

    // Someone else, and a signed-out browser, stay on auto.
    const { fetcher: other } = await signUp("appearance_other");
    expect(htmlTag(await html(await other("/settings/preferences")))).toContain(
      'data-color-scheme="auto"',
    );
    expect(htmlTag(await html(await SELF.fetch(`${ORIGIN}/home`)))).toContain(
      'data-color-scheme="auto"',
    );
  });

  it("goes back to auto and refuses values Mastodon does not have", async () => {
    const { fetcher } = await signUp("appearance_light");
    const light = await html(
      await postForm(fetcher, "/settings/preferences/appearance", {
        color_scheme: "light",
        contrast: "auto",
      }),
    );
    expect(htmlTag(light)).toContain('data-color-scheme="light"');
    expect(htmlTag(light)).toContain('data-contrast="auto"');
    expect(themeColors(light)).toEqual(['<meta name="theme-color" content="#f7f8f8">']);

    const refused = await postForm(fetcher, "/settings/preferences/appearance", {
      color_scheme: "sepia",
      contrast: "auto",
    });
    const page = await html(refused, 422);
    expect(page).toContain("Choose a color scheme");
    expect(htmlTag(page)).toContain('data-color-scheme="light"');

    const auto = await html(
      await postForm(fetcher, "/settings/preferences/appearance", {
        color_scheme: "auto",
        contrast: "auto",
      }),
    );
    expect(htmlTag(auto)).toContain('data-color-scheme="auto"');
    expect(themeColors(auto)).toHaveLength(2);
    expect(htmlTag(await html(await fetcher("/home")))).toContain('data-color-scheme="auto"');
  });

  it("asks a signed-out browser to sign in, and refuses a cross-site post", async () => {
    const signedOut = await SELF.fetch(`${ORIGIN}/settings/preferences/appearance`, {
      redirect: "manual",
    });
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("location")).toBe(
      `/auth/sign_in?return_to=${encodeURIComponent("/settings/preferences/appearance")}`,
    );
    const { fetcher } = await signUp("appearance_csrf");
    const crossSite = await fetcher("/settings/preferences/appearance", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "Sec-Fetch-Site": "cross-site",
      },
      body: "color_scheme=dark&contrast=high",
    });
    expect(crossSite.status).toBe(403);
    await crossSite.body?.cancel();
    expect(htmlTag(await html(await fetcher("/settings/preferences")))).toContain(
      'data-color-scheme="auto"',
    );
  });

  it("leaves a page alone on auto and rewrites only the root element otherwise", async () => {
    const source = `<!doctype html><html lang="en" data-color-scheme="auto" data-contrast="auto"><head><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#08090a" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#f7f8f8" media="(prefers-color-scheme: light)"></head><body><p data-color-scheme="auto">x</p></body></html>`;
    const response = () => new Response(source, { headers: { "content-type": "text/html" } });
    const untouched = applyAppearance(response(), { colorScheme: "auto", contrast: "auto" });
    expect(await untouched.text()).toBe(source);
    const contrastOnly = await applyAppearance(response(), {
      colorScheme: "auto",
      contrast: "high",
    }).text();
    expect(htmlTag(contrastOnly)).toContain('data-contrast="high"');
    expect(themeColors(contrastOnly)).toHaveLength(2);
    expect(contrastOnly).toContain('<p data-color-scheme="auto">');
  });
});
