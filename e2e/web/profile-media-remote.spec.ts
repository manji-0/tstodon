import type { Page } from "@playwright/test";
import { expect, signUp, test } from "./fixtures";
import { png } from "./png";

/**
 * Editing the profile, posting with an image, and looking up an account on
 * another server (the stand-in served by e2e/web/remote-server.mjs).
 */

const person = (name: string): string => `${name}_${Date.now().toString(36).slice(-5)}`;

const status = (page: Page, text: string) =>
  page.locator(".status").filter({ has: page.locator(".status__content", { hasText: text }) });

test.describe("Mastodon web UI: profile, media, remote accounts", () => {
  test("edits the display name and bio", async ({ page }) => {
    const me = person("editor");
    await signUp(page, me);
    await page.goto("/profile/edit");

    await page.getByRole("button", { name: "Edit display name" }).click();
    const nameDialog = page.getByRole("dialog");
    await nameDialog.locator("input").fill("Edited In E2E");
    await nameDialog.getByRole("button", { name: "Save" }).click();
    await expect(nameDialog).toBeHidden();

    await page.getByRole("button", { name: "Add bio" }).click();
    const bioDialog = page.getByRole("dialog");
    await bioDialog.locator("textarea").fill("A bio written by the browser suite.");
    await bioDialog.getByRole("button", { name: "Save" }).click();
    await expect(bioDialog).toBeHidden();

    // The public profile shows both, from the API rather than the edit page's state.
    await page.goto(`/@${me}`);
    await expect(page.getByRole("heading", { name: "Edited In E2E" })).toBeVisible();
    await expect(page.getByText("A bio written by the browser suite.")).toBeVisible();
  });

  test("posts with an image and shows it", async ({ page }) => {
    await signUp(page, person("photographer"));
    const uploaded = page.waitForResponse(
      (response) => response.url().includes("/api/v2/media") && response.ok(),
    );
    await page.locator(".compose-form input[type=file]").setInputFiles({
      name: "red.png",
      mimeType: "image/png",
      buffer: png(64, 48),
    });
    await uploaded;
    await page.getByPlaceholder("What's on your mind?").fill("a red square");
    await page.locator(".compose-form").getByRole("button", { name: "Post", exact: true }).click();
    // The UI asks for alt text first; describe the image there.
    await page.getByRole("button", { name: "Add alt text" }).click();
    const editor = page.getByRole("dialog");
    await editor.locator("textarea").fill("A solid red rectangle");
    await editor.getByRole("button", { name: /^(Done|Apply|Save)$/ }).click();
    await expect(editor).toBeHidden();
    await page.locator(".compose-form").getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.getByText("Post published.")).toBeVisible({ timeout: 30_000 });

    const image = status(page, "a red square").locator(".media-gallery img").first();
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute("alt", "A solid red rectangle");
    // The attachment reports the stored size, so the gallery offers both
    // copies by width and the browser picks one for the column.
    await expect(image).toHaveAttribute("srcset", / 64w, .* 64w$/);
    // The browser actually loaded the stored image. With a `w` srcset,
    // `naturalWidth` is the width the image is laid out at, not the file's, so
    // decode the copy it chose on its own.
    await expect
      .poll(() =>
        image.evaluate(async (element: HTMLImageElement) => {
          if (!element.complete || element.currentSrc === "") return undefined;
          const file = new Image();
          file.src = element.currentSrc;
          await file.decode();
          return { width: file.naturalWidth, height: file.naturalHeight };
        }),
      )
      .toEqual({ width: 64, height: 48 });
  });

  test("looks up an account on another server", async ({ page }) => {
    await signUp(page, person("explorer"));
    await page.getByPlaceholder("Search or paste URL").fill("@remote_alice@127.0.0.1:8794");
    await page.keyboard.press("Enter");

    const result = page.getByRole("link", { name: /Remote Alice/ }).first();
    await expect(result).toBeVisible();
    await result.click();

    await expect(page.getByRole("heading", { name: "Remote Alice" })).toBeVisible();
    await expect(page.getByText("I live on another server.")).toBeVisible();
    await expect(page.locator('img[src="http://127.0.0.1:8794/avatar.png"]').first()).toBeVisible();
  });

  test("favourites and boosts a post from another server", async ({ page }) => {
    // The outbox backfill runs on the queue, so the post can take a while to appear.
    test.setTimeout(150_000);
    await signUp(page, person("engager"));
    const openProfile = async () => {
      await page.goto("/home");
      await page.getByPlaceholder("Search or paste URL").fill("@remote_alice@127.0.0.1:8794");
      await page.keyboard.press("Enter");
      await page
        .getByRole("link", { name: /Remote Alice/ })
        .first()
        .click();
      await expect(page.getByRole("heading", { name: "Remote Alice" })).toBeVisible();
    };

    // The first visit queues the outbox backfill that brings her post in.
    const post = status(page, "Greetings from the remote server");
    await expect(async () => {
      await openProfile();
      await expect(post).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 45_000 });

    const favourited = page.waitForResponse(
      (response) => /\/api\/v1\/statuses\/[^/]+\/favourite$/.test(response.url()) && response.ok(),
    );
    await post.getByRole("button", { name: "Favorite" }).click();
    await favourited;
    await expect(post.getByRole("button", { name: "Remove from favorites" })).toBeVisible();

    const reblogged = page.waitForResponse(
      (response) => /\/api\/v1\/statuses\/[^/]+\/reblog$/.test(response.url()) && response.ok(),
    );
    await post.getByRole("button", { name: "Boost or quote" }).click();
    await page.getByRole("button", { name: "Boost", exact: true }).click();
    await reblogged;

    // What the server kept: the post on Favorites, and the boost on home.
    await page.goto("/favourites");
    await expect(post).toBeVisible();
    await page.goto("/home");
    await expect(post).toBeVisible();
    await expect(page.getByText(/boosted/).first()).toBeVisible();
  });
});
