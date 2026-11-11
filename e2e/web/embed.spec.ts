import { expect, signUp, test } from "./fixtures";

/**
 * "Get embed code" on a post: the dialog shows the oEmbed HTML and a preview,
 * where `/embed.js` frames the post's embed page, which renders the post.
 */

const person = (name: string): string => `${name}_${Date.now().toString(36).slice(-5)}`;

test("shows a post's embed code and the embedded post", async ({ page }) => {
  const me = person("embedder");
  await signUp(page, me);
  await page.getByPlaceholder("What's on your mind?").fill("a post worth embedding");
  await page.locator(".compose-form").getByRole("button", { name: "Post" }).click();
  await expect(page.getByText("Post published.")).toBeVisible({ timeout: 30_000 });

  const post = page
    .locator(".status")
    .filter({ has: page.locator(".status__content", { hasText: "a post worth embedding" }) });
  await post.getByRole("button", { name: "More" }).click();
  await page.getByText("Get embed code", { exact: true }).click();

  await expect(page.getByRole("heading", { name: "Get embed code" })).toBeVisible();
  await expect(page.locator(".dialog-modal textarea")).toHaveValue(
    /<blockquote class="mastodon-embed" data-embed-url="[^"]+\/@[^/]+\/\d+\/embed"/,
  );
  const embedded = page.frameLocator('iframe[title="Preview"]').frameLocator("iframe");
  await expect(embedded.getByText("a post worth embedding")).toBeVisible({ timeout: 30_000 });
});
