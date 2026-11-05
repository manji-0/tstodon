import {
  expect,
  test as base,
  type APIRequestContext,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "@playwright/test";
import { z } from "zod";

type PasskeyDevice = Readonly<{ cdp: CDPSession; authenticatorId: string }>;
const devices = new WeakMap<Page, PasskeyDevice>();

const newPasskeyDevice = async (context: BrowserContext, page: Page): Promise<PasskeyDevice> => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
};

/**
 * Give the context's browser a platform authenticator (Chromium's virtual
 * WebAuthn device), so passkey prompts complete without a person. Each page
 * gets its own; a credential lives on the authenticator that created it.
 */
export const addPasskeyDevice = async (context: BrowserContext, page: Page): Promise<void> => {
  devices.set(page, await newPasskeyDevice(context, page));
};

/**
 * Swap the page's authenticator for an empty one: another device, as far as
 * a site can tell, so it can register a second passkey for the same person.
 */
export const replacePasskeyDevice = async (context: BrowserContext, page: Page): Promise<void> => {
  const old = devices.get(page);
  await old?.cdp.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: old.authenticatorId,
  });
  await addPasskeyDevice(context, page);
};

const kvApi = "/cdn-cgi/local/explorer/api/storage/kv/namespaces";
const KvNamespaces = z.object({
  result: z.array(z.object({ id: z.string(), title: z.string() })),
});

/**
 * The confirmation link the server "sent" (`EMAIL_TRANSPORT=capture` keeps it
 * in KV), read through the dev server's local explorer API. Spawning
 * `wrangler kv key get` instead costs seconds per sign-up on a busy machine,
 * enough to push the multi-person scenarios past their timeout.
 */
export const confirmationLink = async (
  request: APIRequestContext,
  email: string,
): Promise<string> => {
  const namespaces = KvNamespaces.parse(await (await request.get(kvApi)).json());
  const appCache = namespaces.result.find((namespace) => namespace.title === "APP_CACHE");
  if (!appCache) {
    throw new Error("the dev server has no APP_CACHE KV namespace");
  }
  const mail = await (
    await request.get(`${kvApi}/${appCache.id}/values/mailbox:${email.toLowerCase()}`)
  ).text();
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
  await page.goto(await confirmationLink(page.request, email));
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
