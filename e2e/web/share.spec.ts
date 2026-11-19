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
  // The standalone composer goes to the new post's `url`, its page in the web app.
  await expect(page).toHaveURL(new RegExp(`/@${me}/\\d+$`), { timeout: 30_000 });
  await expect(page.getByText("shared from another site").first()).toBeVisible();
  const id = page.url().split("/").at(-1) ?? "";
  const postUri = new URL(`/users/${me}/statuses/${id}`, page.url()).href;

  // Its ActivityPub URI, opened in a browser, is that page too.
  await page.goto(postUri);
  await expect(page).toHaveURL(`/@${me}/${id}`);

  await page.goto("/home");
  await page.goto(`/authorize_interaction?${new URLSearchParams({ uri: postUri }).toString()}`);
  await expect(page).toHaveURL(`/@${me}/${id}`);
  await expect(page.getByText("shared from another site").first()).toBeVisible();
});
