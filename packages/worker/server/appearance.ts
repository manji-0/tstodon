import type { Context, Next } from "hono";
import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { parseRows, type RepositoryError, runD1 } from "./d1";

/**
 * Mastodon's appearance preferences, `color_scheme` (auto, light, dark) and
 * `contrast` (auto, high) in its user settings: what the HTML shell and the
 * Worker's own pages render as `data-color-scheme` / `data-contrast`. `auto`
 * follows the browser's `prefers-color-scheme` / `prefers-contrast`; a
 * signed-out visitor, and an account that never chose, get `auto` for both.
 */

export const COLOR_SCHEMES = ["auto", "light", "dark"] as const;
export const CONTRASTS = ["auto", "high"] as const;

export type ColorScheme = (typeof COLOR_SCHEMES)[number];
export type Contrast = (typeof CONTRASTS)[number];

export type Appearance = Readonly<{ colorScheme: ColorScheme; contrast: Contrast }>;

export const DEFAULT_APPEARANCE: Appearance = { colorScheme: "auto", contrast: "auto" };

export const ColorSchemeSchema = z.literal(COLOR_SCHEMES);
export const ContrastSchema = z.literal(CONTRASTS);

const AppearanceRow = z.object({ color_scheme: ColorSchemeSchema, contrast: ContrastSchema });

export const findAppearance = async (
  db: D1Database,
  accountId: string,
): Promise<Result<Appearance, RepositoryError>> =>
  runD1(async () => {
    const found = await db
      .prepare("SELECT color_scheme, contrast FROM account_appearance WHERE account_id = ? LIMIT 1")
      .bind(accountId)
      .first();
    const row = found === null ? undefined : parseRows(AppearanceRow, [found])[0];
    return row === undefined
      ? DEFAULT_APPEARANCE
      : { colorScheme: row.color_scheme, contrast: row.contrast };
  });

export const saveAppearance = async (
  db: D1Database,
  accountId: string,
  appearance: Appearance,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `INSERT INTO account_appearance (account_id, color_scheme, contrast, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET
           color_scheme = excluded.color_scheme,
           contrast = excluded.contrast,
           updated_at = excluded.updated_at`,
      )
      .bind(accountId, appearance.colorScheme, appearance.contrast, nowIso())
      .run();
  });

/** The app background per scheme (`--color-bg-app`), for `<meta name="theme-color">`. */
export const THEME_COLORS = { dark: "#08090a", light: "#f7f8f8" } as const;

/** The `theme-color` metas: both, by media query, for `auto`; one for a chosen scheme. */
export const themeColorMetas = (colorScheme: ColorScheme): string =>
  colorScheme === "auto"
    ? `<meta name="theme-color" content="${THEME_COLORS.dark}" media="(prefers-color-scheme: dark)">
    <meta name="theme-color" content="${THEME_COLORS.light}" media="(prefers-color-scheme: light)">`
    : `<meta name="theme-color" content="${THEME_COLORS[colorScheme]}">`;

/**
 * The account a request's browser session resolved to, recorded by
 * `browserSession`: the Worker's pages render through `page()`, which knows
 * no viewer, and the middleware below applies that account's appearance to
 * them without a second session lookup.
 */
const signedInAccounts = new WeakMap<Request, string>();

export const rememberSignedInAccount = (request: Request, accountId: string): void => {
  signedInAccounts.set(request, accountId);
};

const isHtml = (response: Response): boolean =>
  (response.headers.get("Content-Type") ?? "").startsWith("text/html");

/**
 * Sets `data-color-scheme` / `data-contrast` (and `theme-color`) on an HTML
 * page to the signed-in account's appearance. Pages for a signed-out browser,
 * and accounts on `auto` / `auto`, pass through unchanged.
 */
export const applyAppearance = (response: Response, appearance: Appearance): Response => {
  if (appearance.colorScheme === "auto" && appearance.contrast === "auto") {
    return response;
  }
  const { colorScheme } = appearance;
  let themeColorWritten = false;
  return new HTMLRewriter()
    .on("html", {
      element(element) {
        element.setAttribute("data-color-scheme", colorScheme);
        element.setAttribute("data-contrast", appearance.contrast);
      },
    })
    .on('meta[name="color-scheme"]', {
      element(element) {
        if (colorScheme !== "auto") {
          element.setAttribute("content", colorScheme);
        }
      },
    })
    .on('meta[name="theme-color"]', {
      element(element) {
        if (colorScheme === "auto") {
          return;
        }
        if (themeColorWritten) {
          element.remove();
          return;
        }
        themeColorWritten = true;
        element.setAttribute("content", THEME_COLORS[colorScheme]);
        element.removeAttribute("media");
      },
    })
    .transform(response);
};

/** Request-wide middleware (`app/middleware/06.page-appearance.ts`). */
export const pageAppearanceMiddleware = async (c: Context<{ Bindings: Env }>, next: Next) => {
  await next();
  const accountId = signedInAccounts.get(c.req.raw);
  if (accountId === undefined || !isHtml(c.res)) {
    return;
  }
  const appearance = await findAppearance(c.env.DB, accountId);
  if (appearance.isOk()) {
    c.res = applyAppearance(c.res, appearance.value);
  }
};
