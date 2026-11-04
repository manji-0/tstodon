import type { Page } from "@playwright/test";
import { expect, signUp, test } from "./fixtures";

/**
 * The web app's admin links: they land on this server's admin pages, where
 * an admin (`ADMIN_USERNAMES` in e2e/web.wrangler.jsonc) handles a report.
 */

const person = (name: string): string => `${name}_${Date.now().toString(36).slice(-5)}`;

/** File a report as the signed-in web app user, with the token its page carries. */
const fileReport = async (page: Page, targetUsername: string, comment: string) =>
  page.evaluate(
    async ({ targetUsername, comment }) => {
      const state = JSON.parse(document.getElementById("initial-state")?.textContent ?? "{}");
      const headers = {
        Authorization: `Bearer ${state.meta.access_token}`,
        "Content-Type": "application/json",
      };
      const target = await (await fetch(`/api/v1/accounts/lookup?acct=${targetUsername}`)).json();
      const report = await fetch("/api/v1/reports", {
        method: "POST",
        headers,
        body: JSON.stringify({ account_id: target.id, comment, category: "spam" }),
      });
      return { status: report.status, id: (await report.json()).id };
    },
    { targetUsername, comment },
  );

test.describe("admin links in the web UI", () => {
  test("an admin opens a report from the More menu and resolves it", async ({
    page,
    newPerson,
  }) => {
    const target = person("spammer");
    const other = await newPerson();
    await signUp(other, target);

    await signUp(page, "modadmin");
    const report = await fileReport(page, target, "Posts nothing but spam links.");
    expect(report.status).toBe(200);

    await page.getByRole("button", { name: "More" }).click();
    const [moderation] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByRole("link", { name: "Moderation" }).click(),
    ]);
    await expect(moderation).toHaveURL(/\/admin\/reports$/);
    await expect(moderation.getByRole("heading", { name: "Reports" })).toBeVisible();
    await expect(moderation.getByText("Posts nothing but spam links.")).toBeVisible();

    await moderation.getByRole("link", { name: `Report #${report.id}` }).click();
    await expect(moderation.getByRole("heading", { name: `Report #${report.id}` })).toBeVisible();
    await moderation.getByRole("button", { name: "Mark as resolved" }).click();
    await expect(moderation.getByText("Report resolved.")).toBeVisible();
    await expect(moderation.getByText("resolved by @modadmin")).toBeVisible();
    await moderation.getByRole("link", { name: "Reports", exact: true }).click();
    await moderation.getByRole("link", { name: "Resolved" }).click();
    await expect(moderation.getByRole("link", { name: `Report #${report.id}` })).toBeVisible();
  });

  test("an admin opens an account's moderation page from its profile menu", async ({
    page,
    newPerson,
  }) => {
    const target = person("limited");
    const other = await newPerson();
    await signUp(other, target);
    await signUp(page, "modadmin2");

    await page.goto(`/@${target}`);
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    const [moderation] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByRole("link", { name: `Open moderation interface for @${target}` }).click(),
    ]);
    await expect(moderation.getByRole("heading", { name: `@${target}` })).toBeVisible();
    await moderation.getByRole("button", { name: "Limit" }).click();
    await expect(moderation.getByText("Account updated.")).toBeVisible();
    await expect(moderation.getByText("State: limited")).toBeVisible();
  });
});
