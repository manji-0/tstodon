import type { Page } from "@playwright/test";
import { dropAccessLogin, expect, signIn, signUp, test } from "./fixtures";

/**
 * Basic operations in Mastodon's web UI against this server: visiting signed
 * out, signing in through Access, posting, favouriting and bookmarking,
 * following, replying, notifications, and editing the profile.
 */

/** A username no earlier run of the suite has used (the database is fresh per run anyway). */
const person = (name: string): string => `${name}_${Date.now().toString(36).slice(-5)}`;

/** The compose button: "Post", or "Reply" while replying. */
const publish = async (page: Page): Promise<void> => {
  await page
    .locator(".compose-form")
    .getByRole("button", { name: /^(Post|Reply)$/ })
    .click();
  // The dev server compiles a route on its first request, so the first post is slow.
  await expect(page.getByText("Post published.")).toBeVisible({ timeout: 30_000 });
};

const post = async (page: Page, text: string): Promise<void> => {
  await page.getByPlaceholder("What's on your mind?").fill(text);
  await publish(page);
};

/** The rendered post (`.status`) whose text includes `text`. */
const status = (page: Page, text: string) =>
  page.locator(".status").filter({ has: page.locator(".status__content", { hasText: text }) });

test.describe("Mastodon web UI", () => {
  test("shows the server to a signed-out visitor", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/tstodon-e2e-web/);
    await expect(page.getByRole("link", { name: "Create account" })).toHaveAttribute(
      "href",
      /\/auth\/sign_up/,
    );
    await expect(page.getByRole("link", { name: "Login" })).toHaveAttribute(
      "href",
      /\/auth\/sign_in/,
    );
    await page.getByRole("link", { name: "About localhost:8793" }).click();
    await expect(page.getByText("Cloudflare Workers + D1 + R2 + Queues")).toBeVisible();
  });

  test("signs up, posts, and finds the post on the timeline and profile", async ({ page }) => {
    const me = person("poster");
    await signUp(page, me);
    await expect(page.getByRole("link", { name: `${me} @${me}` }).first()).toBeVisible();

    await post(page, "hello from the e2e suite #tstodon");
    // The streaming socket puts the new post on the home timeline.
    await expect(status(page, "hello from the e2e suite")).toBeVisible();

    await page.goto(`/@${me}`);
    await expect(status(page, "hello from the e2e suite")).toBeVisible();
    // And it is still there after a reload (served from the API, not the stream).
    await page.goto("/home");
    await expect(status(page, "hello from the e2e suite")).toBeVisible();
  });

  test("favourites and bookmarks a post", async ({ page }) => {
    await signUp(page, person("keeper"));
    await post(page, "worth keeping");
    const kept = status(page, "worth keeping");
    await kept.getByRole("button", { name: "Favorite" }).click();
    await kept.getByRole("button", { name: "Bookmark" }).click();

    await page.goto("/favourites");
    await expect(status(page, "worth keeping")).toBeVisible();
    await page.goto("/bookmarks");
    await expect(status(page, "worth keeping")).toBeVisible();
  });

  test("follows someone, sees their posts, and both sides are notified", async ({
    page,
    newPerson,
  }) => {
    const author = person("author");
    const reader = person("reader");
    const authorPage = await newPerson();
    await signUp(authorPage, author);
    await post(authorPage, "a post for my followers");

    await signUp(page, reader);
    await page.goto(`/@${author}`);
    await page.getByRole("button", { name: "Follow", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unfollow" })).toBeVisible();

    // The author's next post reaches the reader's home timeline.
    await post(authorPage, "fresh news for followers");
    await page.goto("/home");
    await expect(status(page, "fresh news for followers")).toBeVisible();

    // The reader favourites it and replies.
    const news = status(page, "fresh news for followers");
    await news.getByRole("button", { name: "Favorite" }).click();
    await news.getByRole("button", { name: "Reply" }).click();
    await expect(page.getByPlaceholder("What's on your mind?")).toHaveValue(
      new RegExp(`@${author}`),
    );
    await page.getByPlaceholder("What's on your mind?").pressSequentially(" thanks for the news");
    await publish(page);

    // The author sees the follow, the favourite, and the reply.
    await authorPage.goto("/notifications");
    await expect(authorPage.getByText(/followed you/)).toBeVisible();
    await expect(authorPage.getByText(/favorited your post/)).toBeVisible();
    await expect(authorPage.getByText("thanks for the news")).toBeVisible();
  });

  test("signs out of the local session and signs back in through Access", async ({ page }) => {
    const me = person("returning");
    await signUp(page, me);
    await page.goto("/auth/sign_in");
    await expect(page.getByText(`@${me}`)).toBeVisible();
    // Sign-out navigates to Access logout; let that navigation land before
    // starting another, or the two race and one aborts (ERR_ABORTED).
    await Promise.all([
      page.waitForURL(/\/cdn-cgi\/access\/logout/),
      page.getByRole("button", { name: "Sign out" }).click(),
    ]);
    // Access logout is what ends the login. Dropping the assertion is that step.
    await dropAccessLogin(page);
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Login" })).toBeVisible();

    await signIn(page, me);
    await expect(page.getByRole("link", { name: `${me} @${me}` }).first()).toBeVisible();
    await post(page, "back again");
    await expect(status(page, "back again")).toBeVisible();
  });
});
