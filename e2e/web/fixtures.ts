import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import { signAccessJwt } from "../../packages/worker/test/access-jwt-fixture";

/**
 * Browser e2e signs in the way the Worker does: a Cloudflare Access JWT on
 * `Cf-Access-Jwt-Assertion`. Access itself (a passkey, or an IdP such as
 * WorkOS) is not running here. The test key signs the assertion; the e2e
 * Worker trusts the matching public JWKS.
 */

const signInAs = async (page: Page, email: string): Promise<void> => {
  const assertion = await signAccessJwt({ email });
  await page.setExtraHTTPHeaders({ "Cf-Access-Jwt-Assertion": assertion });
};

/** Provision `username` from an Access login and open the web app as that person. */
export const signUp = async (page: Page, username: string): Promise<void> => {
  await signInAs(page, `${username}@mail.example`);
  await page.goto("/auth/sign_in");
  await page.goto("/");
  await expect(page.getByRole("link", { name: `${username} @${username}` }).first()).toBeVisible();
};

/**
 * Sign in again as `username`. The previous assertion must have been dropped
 * (see {@link dropAccessLogin}); sending it again is a new Access login.
 */
export const signIn = async (page: Page, username: string): Promise<void> => {
  await signInAs(page, `${username}@mail.example`);
  await page.goto("/");
};

/**
 * Stand in for Access logout. The Worker cannot drop `Cf-Access-Jwt-Assertion`;
 * while the header is still sent, the next request signs the person in again.
 */
export const dropAccessLogin = async (page: Page): Promise<void> => {
  await page.setExtraHTTPHeaders({});
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
  /** A signed-out page; fails the test on UI errors. */
  page: Page;
  /** Open a second, separate browser (another person). */
  newPerson: () => Promise<Page>;
};

export const test = base.extend<Fixtures>({
  page: async ({ page }, use) => {
    const problems: string[] = [];
    watchForErrors(page, problems);
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
      return page;
    });
    await Promise.all(opened.map((context) => context.close()));
    expect(problems, "errors in the other browser").toEqual([]);
  },
});

export { expect };
