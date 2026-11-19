import { expect, signUp, test } from "./fixtures";

/**
 * The pages other servers send people to: `/share` (the WebFinger FEP-3b86
 * `Create` template) posts the shared text from the standalone composer, and
 * `/authorize_interaction` (the `subscribe` template) opens the post it names.
 */

const person = (name: string): string => `${name}_${Date.now().toString(36).slice(-5)}`;

test("shares text from /share and opens the post from /authorize_interaction", async ({ page }) => {
  const me = person("sharer");
  await signUp(page, me);
  await page.goto(`/share?${new URLSearchParams({ text: "shared from another site" }).toString()}`);
  const composer = page.locator("#mastodon-compose textarea");
  await expect(composer).toHaveValue("shared from another site");
  await page.locator(".compose-form").getByRole("button", { name: "Post" }).click();
  // The standalone composer goes to the new post's `url`, which is its URI here.
  await expect(page).toHaveURL(new RegExp(`/users/${me}/statuses/\\d+$`), { timeout: 30_000 });
  const postUri = page.url();
  const id = postUri.split("/").at(-1) ?? "";

  await page.goto("/home");
  await page.goto(`/authorize_interaction?${new URLSearchParams({ uri: postUri }).toString()}`);
  await expect(page).toHaveURL(`/@${me}/${id}`);
  await expect(page.getByText("shared from another site").first()).toBeVisible();
});
