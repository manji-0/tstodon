import { deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { expect, signUp, test } from "./fixtures";

/**
 * Editing the profile, posting with an image, and looking up an account on
 * another server (the stand-in served by e2e/web/remote-server.mjs).
 */

const person = (name: string): string => `${name}_${Date.now().toString(36).slice(-5)}`;

const status = (page: Page, text: string) =>
  page.locator(".status").filter({ has: page.locator(".status__content", { hasText: text }) });

/** A small solid-colour PNG, made here so no binary lives in the repository. */
const png = (width: number, height: number): Buffer => {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
  });
  const crc = (bytes: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of bytes) {
      c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(width * 3, Buffer.from([200, 60, 60])),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

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
    // The browser actually loaded the stored image.
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBe(64);
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
});
