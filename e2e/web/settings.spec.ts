import { expect, replacePasskeyDevice, signUp, test } from "./fixtures";

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
    await expect(filters.getByRole("heading", { name: "Muted words" })).toBeVisible();
    await filters.getByRole("link", { name: "Add new filter" }).click();
    await filters.getByLabel("Title").fill("Spoilers");
    await filters.getByLabel("Keyword or phrase").first().fill("season finale");
    await filters.getByRole("button", { name: "Create filter" }).click();
    await expect(filters.getByText("Filter created.")).toBeVisible();
    await expect(filters.getByText("Spoilers")).toBeVisible();
    await filters.getByRole("link", { name: "Edit" }).click();
    await expect(filters.getByLabel("Title")).toHaveValue("Spoilers");
    await expect(filters.getByLabel("Keyword or phrase").first()).toHaveValue("season finale");
  });

  test("adds, renames, and removes a passkey, and keeps the last one", async ({
    context,
    page,
  }) => {
    await signUp(page, person("sec"));
    await page.goto("/settings/preferences");
    await page.getByRole("link", { name: "Password and security" }).click();
    await expect(page).toHaveURL(/\/auth\/edit$/);
    await expect(page.getByRole("heading", { name: "Password and security" })).toBeVisible();
    await expect(page.getByText("This is your only passkey")).toBeVisible();
    await expect(page.getByText("Phone", { exact: true })).toBeVisible();
    await expect(page.getByText("This browser")).toBeVisible();

    await replacePasskeyDevice(context, page);
    await page.getByLabel("Name for the new passkey").fill("Laptop");
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await expect(page.getByText("Laptop", { exact: true })).toBeVisible();

    await page.getByLabel("Name", { exact: true }).last().fill("Work laptop");
    await page.getByRole("button", { name: "Rename" }).last().click();
    await expect(page.getByText("Passkey renamed.")).toBeVisible();
    await expect(page.getByText("Work laptop", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Remove passkey" }).last().click();
    await expect(page.getByText("Passkey removed.")).toBeVisible();
    await expect(page.getByText("This is your only passkey")).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove passkey" })).toHaveCount(0);
  });
  test("downloads a CSV export and uploads an import that finishes", async ({ page }) => {
    await signUp(page, person("data"));
    await page.goto("/settings/preferences");
    await page.getByRole("link", { name: "Export" }).click();
    await expect(page).toHaveURL(/\/settings\/export$/);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Follows" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("follows.csv");

    await page.getByRole("link", { name: "Import", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/import$/);
    await page.getByLabel("Data type").selectOption("DomainBlocks");
    await page.getByLabel("CSV file").setInputFiles({
      name: "domain_blocks.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("spam.example\nads.example\n"),
    });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page).toHaveURL(/\/settings\/imports\/\d+$/);
    await expect(page.getByRole("heading", { name: "Blocked domains import" })).toBeVisible();
    // The page reloads itself until the queue job has applied every row.
    await expect(page.getByText("Finished (merge): 2 done, 0 failed.")).toBeVisible({
      timeout: 30_000,
    });
  });
});
