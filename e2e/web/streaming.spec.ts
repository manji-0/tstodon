import type { Page } from "@playwright/test";
import { expect, signUp, test } from "./fixtures";

/**
 * The streaming socket in Mastodon's web UI: what shows up on a page that is
 * already open, without a reload. Each person here is a separate browser, so
 * what arrives came over the WebSocket the page holds.
 */

const person = (name: string): string => `${name}_${Date.now().toString(36).slice(-5)}`;

/** Console errors and warnings from a page; the scenario asserts there are none. */
const collectConsoleErrors = (page: Page, problems: string[], label: string): void => {
  page.on("response", (response) => {
    if (response.status() >= 400) {
      problems.push(
        `${label} ${response.status()} ${response.request().method()} ${response.url()}`,
      );
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(`${label} console error: ${message.text()} @ ${message.location().url}`);
    }
  });
};

const post = async (page: Page, text: string): Promise<void> => {
  await page.goto("/home");
  const form = page.locator(".compose-form");
  await page.getByPlaceholder("What's on your mind?").fill(text);
  await form.getByRole("button", { name: /^(Post|Reply)$/ }).click();
  await expect(page.getByText("Post published.")).toBeVisible({ timeout: 30_000 });
};

const status = (page: Page, text: string) =>
  page.locator(".status").filter({ has: page.locator(".status__content", { hasText: text }) });

test.describe("live streams in the web UI", () => {
  test.describe.configure({ timeout: 150_000 });
  let problems: string[] = [];
  test.beforeEach(() => {
    problems = [];
  });
  test.afterEach(() => {
    expect(problems, "console errors while the scenario ran").toEqual([]);
  });

  test("a direct message arrives in an open Private mentions column", async ({
    page,
    newPerson,
  }) => {
    const recipient = person("dmrecv");
    const sender = person("dmsend");
    collectConsoleErrors(page, problems, "recipient");
    await signUp(page, recipient);
    const senderPage = await newPerson();
    collectConsoleErrors(senderPage, problems, "sender");
    await signUp(senderPage, sender);

    await page.goto("/conversations");
    await expect(page.getByText("You don't have any private mentions yet.")).toBeVisible();

    await senderPage.goto("/home");
    await senderPage.getByPlaceholder("What's on your mind?").fill(`@${recipient} a secret hello`);
    await senderPage.getByRole("button", { name: /^Public, quotes allowed/ }).click();
    const dialog = senderPage.getByRole("dialog");
    await dialog.getByRole("button", { name: /^Visibility/ }).click();
    await senderPage.getByRole("option", { name: /Private mention/ }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await senderPage
      .locator(".compose-form")
      .getByRole("button", { name: /^Post$/ })
      .click();
    await expect(senderPage.getByText("Post published.")).toBeVisible({ timeout: 30_000 });

    // No reload: the conversation event puts it in the open column.
    await expect(page.getByText("a secret hello")).toBeVisible();
    await expect(page.getByText("You don't have any private mentions yet.")).toBeHidden();
  });

  test("a followed person's post, a follow, and a favourite arrive live", async ({
    page,
    newPerson,
  }) => {
    const reader = person("liver");
    const author = person("liveauth");
    collectConsoleErrors(page, problems, "reader");
    await signUp(page, reader);
    const authorPage = await newPerson();
    collectConsoleErrors(authorPage, problems, "author");
    await signUp(authorPage, author);
    await post(authorPage, "an early post to favourite");

    await page.goto(`/@${author}`);
    await page.getByRole("button", { name: "Follow", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unfollow" })).toBeVisible();

    // Home is open; the author's next post appears without a reload.
    await page.goto("/home");
    await expect(page.getByPlaceholder("What's on your mind?")).toBeVisible();
    await post(authorPage, "live on the home timeline");
    await expect(status(page, "live on the home timeline")).toBeVisible();

    // The author has Notifications open; the reader's follow and favourite arrive.
    await authorPage.goto("/notifications");
    await expect(authorPage.getByText(/followed you/)).toBeVisible();
    await page.goto(`/@${author}`);
    await status(page, "an early post to favourite")
      .getByRole("button", { name: "Favorite" })
      .click();
    await expect(authorPage.getByText(/favorited your post/)).toBeVisible();

    const second = person("liveb");
    const secondPage = await newPerson();
    collectConsoleErrors(secondPage, problems, "second");
    await signUp(secondPage, second);
    await secondPage.goto(`/@${author}`);
    await secondPage.getByRole("button", { name: "Follow", exact: true }).click();
    await expect(secondPage.getByRole("button", { name: "Unfollow" })).toBeVisible();
    await expect(authorPage.getByText(second).first()).toBeVisible();
  });

  test("public posts arrive live in the Local and Federated timelines", async ({
    page,
    newPerson,
  }) => {
    const watcher = person("pubwatch");
    const author = person("pubauth");
    collectConsoleErrors(page, problems, "watcher");
    await signUp(page, watcher);
    const authorPage = await newPerson();
    collectConsoleErrors(authorPage, problems, "author");
    await signUp(authorPage, author);

    await page.goto("/public/local");
    await expect(page.getByText("This server", { exact: true })).toBeVisible();
    await post(authorPage, "hello local timeline");
    await expect(status(page, "hello local timeline")).toBeVisible();

    await page.getByText("All", { exact: true }).click();
    await expect(status(page, "hello local timeline")).toBeVisible();
    await post(authorPage, "hello federated timeline");
    await expect(status(page, "hello federated timeline")).toBeVisible();
  });
});
