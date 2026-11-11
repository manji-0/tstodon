import type { Page } from "@playwright/test";
import { expect, signUp, test } from "./fixtures";

/**
 * Lists the web UI pages through by the `Link` header's `next` URL: scrolling
 * to the end of the first page loads the second.
 */

const person = (name: string): string => `${name}_${Date.now().toString(36).slice(-5)}`;

/** `paged-01`…: one marker per post, none a prefix of another. */
const marker = (prefix: string, n: number): string => `${prefix}-${String(n).padStart(2, "0")}`;

const postStatuses = async (
  page: Page,
  count: number,
  body: (n: number) => Readonly<Record<string, string>>,
): Promise<void> => {
  // The web UI's own token, from the initial state it boots from.
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
  for (let n = 1; n <= count; n += 1) {
    const response = await page.request.post("/api/v1/statuses", {
      data: body(n),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status(), `post ${n}`).toBe(200);
  }
};

/** Scroll the column down until `text` (on a later page) shows. */
const scrollUntilVisible = async (page: Page, text: string): Promise<void> => {
  await expect(async () => {
    await page.mouse.wheel(0, 10_000);
    await expect(page.getByText(text)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
};

test.describe("paging in the web UI", () => {
  test.describe.configure({ timeout: 150_000 });

  test("Private mentions loads a second page of conversations", async ({ page, newPerson }) => {
    const recipient = person("pagerecv");
    const sender = person("pagesend");
    await signUp(page, recipient);
    const senderPage = await newPerson();
    await signUp(senderPage, sender);
    // 25 conversations: one more page after the first 20.
    await postStatuses(senderPage, 25, (n) => ({
      status: `@${recipient} ${marker("paged", n)}`,
      visibility: "direct",
    }));

    await page.goto("/conversations");
    await expect(page.getByText(marker("paged", 25))).toBeVisible();
    await expect(page.getByText(marker("paged", 6))).toBeVisible();
    await expect(page.getByText(marker("paged", 5))).toHaveCount(0);

    const secondPage = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/conversations") && response.url().includes("max_id="),
    );
    await scrollUntilVisible(page, marker("paged", 1));
    expect((await secondPage).status()).toBe(200);
    for (const n of [5, 4, 3, 2, 1]) {
      await expect(page.getByText(marker("paged", n))).toHaveCount(1);
    }
  });

  test("Explore loads a second page of trending posts", async ({ page }) => {
    const poster = person("pagetrend");
    await signUp(page, poster);
    // The newest public posts with no favourites or boosts trend first, newest
    // first: these 25 fill the first page of 20 and start the second.
    await postStatuses(page, 25, (n) => ({ status: marker("trending", n) }));

    await page.goto("/explore/posts");
    await expect(page.getByText(marker("trending", 25))).toBeVisible();
    await expect(page.getByText(marker("trending", 5))).toHaveCount(0);

    const secondPage = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/trends/statuses") && response.url().includes("offset=20"),
    );
    await scrollUntilVisible(page, marker("trending", 1));
    expect((await secondPage).status()).toBe(200);
  });
});
