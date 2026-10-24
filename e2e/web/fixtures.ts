import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Give the context's browser a platform authenticator (Chromium's virtual
 * WebAuthn device), so passkey prompts complete without a person. Each page
 * gets its own; a credential lives on the authenticator that created it.
 */
export const addPasskeyDevice = async (context: BrowserContext, page: Page): Promise<void> => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
};

/** The confirmation link the server "sent" (`EMAIL_TRANSPORT=capture` keeps it in KV). */
export const confirmationLink = (email: string): string => {
  const mail = execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "kv",
      "key",
      "get",
      `mailbox:${email.toLowerCase()}`,
      "--binding",
      "APP_CACHE",
      "--local",
      "--config",
      "e2e/web.wrangler.jsonc",
      "--persist-to",
      ".wrangler/e2e-web",
    ],
    { cwd: root, encoding: "utf8" },
  );
  const link = /https?:\/\/[^\s"]+\/auth\/sign_up\/verify\?token=[\w-]+/.exec(mail)?.[0];
  if (!link) {
    throw new Error(`no sign-up link mailed to ${email}`);
  }
  // The mail carries the instance's public origin; the test talks to the same host.
  return new URL(link).pathname + new URL(link).search;
};

/** Sign up as `username` through the real pages: form, emailed link, passkey. */
export const signUp = async (page: Page, username: string): Promise<void> => {
  const email = `${username}@mail.example`;
  await page.goto("/auth/sign_up");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send confirmation email" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.goto(confirmationLink(email));
  await expect(page.getByText(`@${username}`)).toBeVisible();
  await page.getByRole("button", { name: "Create passkey" }).click();
  await page.waitForURL("/");
};

/** Sign in again with the passkey already on this page's authenticator. */
export const signIn = async (page: Page): Promise<void> => {
  await page.goto("/auth/sign_in");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.waitForURL("/");
};

/** Problems the UI reports: uncaught errors and failed API calls. */
const watchForErrors = (page: Page, problems: string[]): void => {
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/") && response.status() >= 500) {
      problems.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
    }
  });
};

type Fixtures = {
  /** A signed-out page with a passkey device; fails the test on UI errors. */
  page: Page;
  /** Open a second, separate browser (another person) with its own passkey device. */
  newPerson: () => Promise<Page>;
};

export const test = base.extend<Fixtures>({
  page: async ({ context, page }, use) => {
    const problems: string[] = [];
    watchForErrors(page, problems);
    await addPasskeyDevice(context, page);
    await use(page);
    expect(problems, "errors while the scenario ran").toEqual([]);
  },
  newPerson: async ({ browser, baseURL, locale, viewport }, use) => {
    const opened: BrowserContext[] = [];
    const problems: string[] = [];
    await use(async () => {
      const context = await browser.newContext({
        ...(baseURL === undefined ? {} : { baseURL }),
        ...(locale === undefined ? {} : { locale }),
        viewport,
      });
      opened.push(context);
      const page = await context.newPage();
      watchForErrors(page, problems);
      await addPasskeyDevice(context, page);
      return page;
    });
    await Promise.all(opened.map((context) => context.close()));
    expect(problems, "errors in the other browser").toEqual([]);
  },
});

export { expect };
