import type { Page } from "@playwright/test";
import { expect, signUp, test } from "./fixtures";
import { png } from "./png";

/**
 * Web UI bugs fixed on upstream's main and ported to the vendored copy
 * (`packages/worker/src/UPSTREAM.md`, "Fixes from upstream's main").
 */

const person = (name: string): string => `${name}_${Date.now().toString(36).slice(-5)}`;

/** Marks the document so a full page load (which discards it) can be told from client-side navigation. */
const markDocument = (page: Page) =>
  page.evaluate(() => {
    document.documentElement.dataset.e2eMark = "kept";
  });

const documentKept = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.e2eMark === "kept");

const listTitles = (page: Page) =>
  page.evaluate(async () => {
    const state = JSON.parse(document.getElementById("initial-state")?.textContent ?? "{}");
    const response = await fetch("/api/v1/lists", {
      headers: { Authorization: `Bearer ${state.meta.access_token}` },
    });
    const lists: { id: string; title: string }[] = await response.json();
    return Object.fromEntries(lists.map((list) => [list.id, list.title]));
  });

test("creating and renaming a list saves it without reloading the page", async ({ page }) => {
  await signUp(page, person("lister"));
  await page.goto("/lists/new");
  await page.getByLabel("List name").fill("Upstream fixes");
  await markDocument(page);
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page).toHaveURL(/\/lists\/\d+\/members$/);
  expect(await documentKept(page), "the form submitted without a page load").toBe(true);

  const id = /\/lists\/(\d+)\//.exec(page.url())?.[1] ?? "";
  await page.goto(`/lists/${id}/edit`);
  await expect(page.getByLabel("List name")).toHaveValue("Upstream fixes");
  await page.getByLabel("List name").fill("Upstream fixes, renamed");
  await markDocument(page);
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await listTitles(page))[id]).toBe("Upstream fixes, renamed");
  expect(await documentKept(page), "the form saved without a page load").toBe(true);
  await expect(page).toHaveURL(`/lists/${id}/edit`);
});

test("the about page shows no empty administrator when the server names none", async ({ page }) => {
  await page.goto("/about");
  const administeredBy = page.locator(".about__meta__column").first();
  await expect(administeredBy.getByRole("heading", { name: "Administered by:" })).toBeVisible();
  // `contact.account` is null on this server: upstream rendered `<Account id={undefined}>`,
  // an account row with no name or link.
  await expect(administeredBy.locator(".account")).toHaveCount(0);
  await expect(page.locator(".about__mail[href='mailto:admin@example.com']")).toHaveText(
    "admin@example.com",
  );
  // The signed-out sidebar's server banner rendered the same row.
  await expect(page.locator(".server-banner__meta__column").first()).toBeVisible();
  await expect(page.locator("a[href='/@undefined'], a[href='/@']")).toHaveCount(0);
});

test("the standalone composer at /share suggests the server's custom emoji", async ({ page }) => {
  // An admin (`ADMIN_USERNAMES` in e2e/web.wrangler.jsonc) uploads one.
  const shortcode = `upstream_${Date.now().toString(36).slice(-5)}`;
  await signUp(page, "modadmin");
  await page.goto("/admin/custom_emojis");
  await page.locator("#shortcode").fill(shortcode);
  await page
    .locator("#image")
    .setInputFiles({ name: "emoji.png", mimeType: "image/png", buffer: png(16, 16) });
  await page.getByRole("button", { name: "Upload emoji" }).click();
  await expect(page.getByText(`:${shortcode}:`).first()).toBeVisible();

  // Upstream's /share rendered the composer without `initializeEmoji()`, so
  // the custom emoji never reached the store the suggestions read.
  await page.goto("/share");
  await page
    .locator("#mastodon-compose textarea")
    .pressSequentially(`Hello :${shortcode.slice(0, -1)}`);
  await expect(
    page.locator(".autosuggest-textarea__suggestions .autosuggest-emoji", {
      hasText: `:${shortcode}:`,
    }),
  ).toBeVisible();
});

test("a link in an announcement shows in the brand colour", async ({ page }) => {
  const url = `https://example.org/notes/${Date.now().toString(36)}`;
  await signUp(page, "modadmin");
  await page.goto("/admin/announcements");
  await page.getByLabel("Text").fill(`Release notes: ${url}`);
  await page.getByRole("button", { name: "Create announcement" }).click();
  await expect(page.getByText("Announcement created.")).toBeVisible();

  await page.goto("/home");
  await page.getByRole("button", { name: "Show announcements" }).click();
  const link = page.locator(`.announcements__content a[href="${url}"]`);
  await expect(link).toHaveCount(1);
  // Upstream coloured these links as the text around them (`--color-text-primary`).
  const colours = await link.evaluate((element) => {
    const probe = (variable: string) => {
      const span = document.createElement("span");
      span.style.color = `var(${variable})`;
      element.parentElement?.append(span);
      const colour = getComputedStyle(span).color;
      span.remove();
      return colour;
    };
    return {
      link: getComputedStyle(element).color,
      brand: probe("--color-text-brand"),
      text: probe("--color-text-primary"),
    };
  });
  expect(colours.brand).not.toBe(colours.text);
  expect(colours.link).toBe(colours.brand);
});
