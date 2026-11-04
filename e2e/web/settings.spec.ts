import { expect, signUp, test } from "./fixtures";

/**
 * The web app's links to Mastodon's Rails settings pages: they land on this
 * server's own pages instead of a dead end.
 */

const person = (name: string): string => `${name}_${Date.now().toString(36).slice(-5)}`;

test.describe("settings links in the web UI", () => {
  test("opens Preferences from the menu and reaches account migration", async ({ page }) => {
    await signUp(page, person("prefs"));
    await page.locator(".navigation-panel").getByRole("link", { name: "Preferences" }).click();

    await expect(page).toHaveURL(/\/settings\/preferences$/);
    await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible();
    await page.getByRole("link", { name: "Move to a different account" }).click();
    await expect(page).toHaveURL(/\/settings\/migration$/);
    await expect(page.getByRole("heading", { name: "Move to a different account" })).toBeVisible();
    await expect(page.getByLabel("Handle of the new account")).toBeVisible();
  });

  test("saves privacy and reach opened from the More menu", async ({ page }) => {
    await signUp(page, person("reach"));
    // The More menu opens its Rails pages in another window.
    const fromMoreMenu = async (name: string) => {
      await page.getByRole("button", { name: "More" }).click();
      const [opened] = await Promise.all([
        page.waitForEvent("popup"),
        page.getByRole("link", { name }).click(),
      ]);
      return opened;
    };

    const privacy = await fromMoreMenu("Privacy and reach");
    await expect(privacy.getByRole("heading", { name: "Privacy and reach" })).toBeVisible();
    await privacy.getByLabel(/Automatically accept new followers/).uncheck();
    await privacy.getByRole("button", { name: "Save changes" }).click();
    await expect(privacy.getByText("Changes saved.")).toBeVisible();
    await expect(privacy.getByLabel(/Automatically accept new followers/)).not.toBeChecked();
    await privacy.close();

    const filters = await fromMoreMenu("Muted words");
    await expect(filters.getByText("This page is not available on this server.")).toBeVisible();
  });
});
