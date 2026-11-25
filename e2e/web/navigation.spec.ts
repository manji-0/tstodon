import type { Page } from "@playwright/test";
import { expect, signUp, test } from "./fixtures";
import { png } from "./png";

/**
 * Client-side routing in the web UI: moving between columns with the active
 * link marked, the browser's back and forward buttons (scroll restoration,
 * modals), deep links, redirects, the not-found column, and the advanced
 * (multi-column) layout under `/deck`.
 */

const person = (name: string): string => `${name}_${Date.now().toString(36).slice(-5)}`;

const status = (page: Page, text: string) =>
  page.locator(".status").filter({ has: page.locator(".status__content", { hasText: text }) });

/** The web UI's own token, from the initial state it boots from. */
const webToken = async (page: Page): Promise<string> => {
  const token = await page.evaluate(() => {
    const state: unknown = JSON.parse(
      document.getElementById("initial-state")?.textContent ?? "{}",
    );
    const meta =
      typeof state === "object" && state !== null && "meta" in state ? state.meta : undefined;
    return typeof meta === "object" && meta !== null && "access_token" in meta
      ? String(meta.access_token)
      : "";
  });
  expect(token).not.toBe("");
  return token;
};

/** Post through the API; returns the new status's id. */
const postStatus = async (
  page: Page,
  token: string,
  data: Readonly<Record<string, unknown>>,
): Promise<string> => {
  const response = await page.request.post("/api/v1/statuses", {
    data,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  const id = typeof body === "object" && body !== null && "id" in body ? String(body.id) : "";
  expect(id).not.toBe("");
  return id;
};

const scrollY = (page: Page): Promise<number> => page.evaluate(() => window.scrollY);

/** The navigation panel's link to `href`. */
const panelLink = (page: Page, href: string) =>
  page.locator(`.navigation-panel a.column-link[href="${href}"]`);

test.describe("routing in the web UI", () => {
  test("moves between columns and marks the active links", async ({ page }) => {
    const me = person("router");
    await signUp(page, me);
    const token = await webToken(page);
    const id = await postStatus(page, token, { status: "routing target post" });

    await page.goto("/home");
    await expect(panelLink(page, "/home")).toHaveClass(/\bactive\b/);
    await expect(panelLink(page, "/home")).toHaveAttribute("aria-current", "page");

    await panelLink(page, "/notifications").click();
    await expect(page).toHaveURL(/\/notifications$/);
    await expect(page).toHaveTitle(/^Notifications - /);
    await expect(panelLink(page, "/notifications")).toHaveClass(/\bactive\b/);
    await expect(panelLink(page, "/home")).not.toHaveClass(/\bactive\b/);
    await expect(panelLink(page, "/home")).not.toHaveAttribute("aria-current", "page");

    await panelLink(page, "/explore").click();
    await expect(page).toHaveURL(/\/explore$/);
    const tabs = page.locator(".account__section-headline");
    await expect(tabs.locator('a[href="/explore"]')).toHaveClass(/\bactive\b/);
    await tabs.locator('a[href="/explore/tags"]').click();
    await expect(page).toHaveURL(/\/explore\/tags$/);
    await expect(tabs.locator('a[href="/explore/tags"]')).toHaveClass(/\bactive\b/);
    // `exact`: the Posts tab is no longer active, the panel's Explore link still is.
    await expect(tabs.locator('a[href="/explore"]')).not.toHaveClass(/\bactive\b/);
    await expect(panelLink(page, "/explore")).toHaveClass(/\bactive\b/);

    await panelLink(page, "/lists").click();
    await expect(page).toHaveURL(/\/lists$/);
    await expect(page).toHaveTitle(/^Lists - /);

    await page.getByPlaceholder("Search").fill("routing");
    await page.getByPlaceholder("Search").press("Enter");
    await expect(page).toHaveURL(/\/search\?q=routing/);
    await expect(page).toHaveTitle(/^Search for "routing" - /);

    // Settings live outside the web app: plain links, not router links.
    await expect(page.locator('.navigation-panel a[href="/settings/preferences"]')).toHaveCount(1);

    await page.goto(`/@${me}`);
    const profileTabs = page.locator(".account-timeline__header ~ * a, [class*=tab_list] a");
    await expect(page.locator(`a[href="/@${me}"][aria-current="page"]`)).toHaveCount(1);
    await profileTabs.filter({ hasText: "Media" }).first().click();
    await expect(page).toHaveURL(new RegExp(`/@${me}/media$`));
    await expect(page.locator(`a[href="/@${me}/media"]`)).toHaveClass(/\bactive\b/);
    await expect(page.locator(`a[href="/@${me}"][aria-current="page"]`)).toHaveCount(0);
    // The Activity tab stays current on a featured hashtag's posts.
    await page.goto(`/@${me}/tagged/routing`);
    await expect(page.locator(`a[href="/@${me}"][aria-current="page"]`)).toHaveClass(/\bactive\b/);

    await page.goto(`/@${me}`);
    await status(page, "routing target post").locator(".status__content").click();
    await expect(page).toHaveURL(new RegExp(`/@${me}/${id}$`));
    await expect(page.locator(".detailed-status")).toContainText("routing target post");

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/@${me}$`));
    await expect(status(page, "routing target post")).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/@${me}/${id}$`));
    await expect(page.locator(".detailed-status")).toContainText("routing target post");
  });

  test("restores the timeline's scroll position on back and forward", async ({ page }) => {
    test.setTimeout(150_000);
    const me = person("scroller");
    await signUp(page, me);
    const token = await webToken(page);
    for (let n = 1; n <= 20; n += 1) {
      await postStatus(page, token, {
        status: `scroll-${String(n).padStart(2, "0")}\nline two\nline three\nline four`,
      });
    }

    await page.goto("/home");
    await expect(status(page, "scroll-01")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 900));
    await expect.poll(() => scrollY(page)).toBe(900);
    // The post in the middle of the window. The timeline renders an item that
    // scrolls into view only once its intersection observer fires, so wait
    // for one to be drawn there rather than reading the window at once.
    const middlePost = () =>
      page.evaluate(() => {
        const middle = window.innerHeight / 2;
        const content = [...document.querySelectorAll(".status__content")].find((element) => {
          const { top, bottom } = element.getBoundingClientRect();
          return top < middle && bottom > 0 && top > 0;
        });
        return content?.textContent?.match(/scroll-\d+/)?.[0] ?? "";
      });
    await expect.poll(middlePost).not.toBe("");
    const label = await middlePost();
    const target = status(page, label);
    const before = await scrollY(page);

    await target.locator(".status__content").click();
    await expect(page.locator(".detailed-status")).toContainText(label);
    await expect.poll(() => scrollY(page)).toBeLessThan(before);

    await page.goBack();
    await expect(page).toHaveURL(/\/home$/);
    await expect.poll(() => scrollY(page)).toBe(before);

    await page.goForward();
    await expect(page.locator(".detailed-status")).toContainText(label);
    await expect.poll(() => scrollY(page)).toBeLessThan(before);

    await page.goBack();
    await expect(page).toHaveURL(/\/home$/);
    await expect.poll(() => scrollY(page)).toBe(before);

    // A new navigation (not back) starts at the top.
    await panelLink(page, "/notifications").click();
    await expect(page).toHaveURL(/\/notifications$/);
    await panelLink(page, "/home").click();
    await expect(page).toHaveURL(/\/home$/);
    await expect.poll(() => scrollY(page)).toBe(0);
  });

  test("closes a media modal with back and with Escape", async ({ page }) => {
    const me = person("viewer");
    await signUp(page, me);
    const token = await webToken(page);
    const upload = await page.request.post("/api/v2/media", {
      multipart: {
        file: { name: "red.png", mimeType: "image/png", buffer: png(64, 48) },
        description: "A red rectangle",
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(upload.ok()).toBe(true);
    const media: unknown = await upload.json();
    const mediaId =
      typeof media === "object" && media !== null && "id" in media ? String(media.id) : "";
    const id = await postStatus(page, token, { status: "a modal picture", media_ids: [mediaId] });

    await page.goto("/home");
    await status(page, "a modal picture").locator(".status__content").click();
    await expect(page).toHaveURL(new RegExp(`/@${me}/${id}$`));
    const modal = page.locator(".modal-root__container");
    const image = page.locator(".detailed-status .media-gallery__item-thumbnail").first();

    await image.click();
    await expect(modal.locator(".media-modal")).toBeVisible();
    // Opening the modal adds a history entry for the same URL.
    await expect(page).toHaveURL(new RegExp(`/@${me}/${id}$`));
    await page.goBack();
    await expect(modal).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/@${me}/${id}$`));
    await expect(page.locator(".detailed-status")).toContainText("a modal picture");

    await image.click();
    await expect(modal.locator(".media-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/@${me}/${id}$`));
    // Closing it removed the modal's history entry: back leaves the post.
    await page.goBack();
    await expect(page).toHaveURL(/\/home$/);
    await expect(status(page, "a modal picture")).toBeVisible();
  });

  test("loads deep links, follows redirects and shows the not-found column", async ({ page }) => {
    const me = person("linker");
    await signUp(page, me);
    const token = await webToken(page);
    const id = await postStatus(page, token, { status: "deep linked post" });

    for (const [from, to] of [
      ["/", "/home"],
      ["/getting-started", "/home"],
      ["/deck", "/home"],
      ["/deck/explore", "/explore"],
      [`/deck/@${me}`, `/@${me}`],
    ] as const) {
      await page.goto(from);
      await expect(page, `${from} redirects`).toHaveURL(new RegExp(`${to}$`));
    }
    await expect(page.getByRole("heading", { level: 1, name: me })).toBeVisible();

    await page.goto(`/@${me}/${id}`);
    await expect(page.locator(".detailed-status")).toContainText("deep linked post");
    await page.goto(`/statuses/${id}`);
    await expect(page.locator(".detailed-status")).toContainText("deep linked post");
    await page.goto(`/@${me}/with_replies`);
    await expect(status(page, "deep linked post")).toBeVisible();
    await page.goto("/start");
    await expect(page).toHaveTitle(/^Follow people to get started - /);
    await page.goto("/explore/tags");
    await expect(page.locator('.account__section-headline a[href="/explore/tags"]')).toHaveClass(
      /\bactive\b/,
    );

    await page.goto("/start/nowhere");
    await expect(page.getByText("The requested page could not be found.")).toBeVisible();
    await page.goto(`/@${me}/${id}/nowhere`);
    await expect(page.getByText("The requested page could not be found.")).toBeVisible();
  });

  test("keeps the advanced layout's columns under /deck", async ({ page }) => {
    const me = person("decker");
    await signUp(page, me);
    // The server always sends the single-column layout; turn the advanced one
    // on in the initial state the UI boots from.
    await page.route("**/*", async (route) => {
      if (route.request().resourceType() !== "document") {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      const body = (await response.text()).replace(
        '"advanced_layout":false',
        '"advanced_layout":true',
      );
      await route.fulfill({ response, body });
    });
    const token = await webToken(page);
    const id = await postStatus(page, token, { status: "deck column post" });

    await page.goto("/home");
    await expect(page).toHaveURL(/\/deck\/getting-started$/);
    await expect(page.locator("body")).toHaveClass(/\blayout-multiple-columns\b/);
    const columns = page.locator(".columns-area > .column, .columns-area > .drawer");
    await expect(columns.first()).toBeVisible();
    expect(await columns.count()).toBeGreaterThan(1);

    await page.locator(`.columns-area a[href="/explore"]`).first().click();
    await expect(page).toHaveURL(/\/deck\/explore$/);
    await expect(page.locator('.account__section-headline a[href="/explore"]')).toHaveClass(
      /\bactive\b/,
    );
    await page.locator('.account__section-headline a[href="/explore/tags"]').click();
    await expect(page).toHaveURL(/\/deck\/explore\/tags$/);
    await expect(page.locator('.account__section-headline a[href="/explore/tags"]')).toHaveClass(
      /\bactive\b/,
    );

    await page.goto(`/deck/@${me}`);
    const profile = page
      .locator(".column")
      .filter({ has: page.getByRole("heading", { level: 1, name: me }) });
    await expect(profile).toBeVisible();
    await profile.locator(".status__content", { hasText: "deck column post" }).click();
    await expect(page).toHaveURL(new RegExp(`/deck/@${me}/${id}$`));
    await expect(page.locator(".detailed-status")).toContainText("deck column post");
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/deck/@${me}$`));

    await page.goto("/deck/start/nowhere");
    await expect(page.getByText("The requested page could not be found.")).toBeVisible();
  });
});
