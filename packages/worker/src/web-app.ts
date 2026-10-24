import type { Context, Next } from "hono";
import { getSession } from "void/auth";
import { z } from "zod";
import { InstanceLimits, Languages, schemaResult } from "@tstodon/core";
import { FediRole, type FediRole as FediRoleValue, type LocalAccount } from "@tstodon/domain";
import { disabledAccountIds } from "./account-flag-store";
import { getAccountModeration } from "./account-moderation-store";
import { findAccountByAuthUserId } from "./account-store";
import { runD1 } from "./d1";
import {
  ensureWebAccessToken,
  ensureWebApplication,
  findWebSettings,
} from "./generated/prisma/sql";
import { sha256Hex } from "./oauth-store";
import { credentialAccountDocument } from "./routes/accounts/credentials";
import {
  isLimitedFederation,
  parseInstanceIdentity,
  registrationsOpen,
  termsOfService,
} from "./runtime-config";
import { queryTyped, runTypedBatch } from "./typed-sql";
import { vapidPublicKey } from "./vapid";

/**
 * Mastodon's own web UI, built by `pnpm web:build` into the Workers Assets
 * (`/packs`, `/emoji`, `/sounds`, `/sw.js`). The Worker plays the part of
 * Mastodon's Rails layout: it serves the HTML shell on the web app's paths
 * with the `initial-state` document the UI boots from. A signed-in Better
 * Auth session gets an access token of the built-in web app, derived from the
 * session and removed with it.
 */

const EntrySchema = z.object({
  js: z.string(),
  css: z.array(z.string()),
  preload: z.array(z.string()),
});

const WebManifestSchema = z.object({
  ref: z.string(),
  polyfills: z.string(),
  themeSelection: z.string(),
  inert: z.string(),
  theme: z.string(),
  common: EntrySchema,
  application: EntrySchema,
  locales: z.array(z.string()),
});

export type WebManifest = z.infer<typeof WebManifestSchema>;

const parseWebManifest = schemaResult(WebManifestSchema);

let manifestLoad: Promise<WebManifest | undefined> | undefined;

/** The build's compact manifest, once per isolate; `undefined` without a web build. */
const webManifest = (env: Env, requestUrl: string): Promise<WebManifest | undefined> => {
  manifestLoad ??= (async () => {
    try {
      const response = await env.ASSETS.fetch(new URL("/packs/tstodon-web.json", requestUrl));
      if (!response.ok) {
        return undefined;
      }
      const parsed = parseWebManifest(await response.json());
      return parsed.isOk() ? parsed.value : undefined;
    } catch {
      return undefined;
    }
  })();
  return manifestLoad;
};

/** Paths Mastodon routes to its React app (`config/routes/web_app.rb` and friends). */
const WEB_APP_PATHS: ReadonlyArray<RegExp> = [
  /^\/$/,
  /^\/(?:about|blocks|bookmarks|conversations|directory|domain_blocks|favourites|follow_requests|followed_tags|getting-started|home|keyboard-shortcuts|mutes|overview|overview\/about|pinned|privacy-policy|public|public\/local|public\/remote|publish|search|terms-of-service)$/,
  /^\/(?:collections|deck|explore|links|lists|notifications|notifications_v2|profile|start|statuses|tags|terms-of-service)(?:\/.*)?$/,
  /^\/@[^/]+(?:\/.*)?$/,
];

export const isWebAppPath = (path: string): boolean =>
  WEB_APP_PATHS.some((pattern) => pattern.test(path));

const wantsActivityJson = (accept: string | undefined): boolean =>
  /application\/(?:activity\+json|ld\+json)/.test(accept ?? "");

/** `/@alice` and `/@alice/123` for an ActivityPub client: the actor and note URLs. */
const activityPubTarget = (path: string): string | undefined => {
  const match = /^\/@([^/@]+)(?:\/([^/]+))?\/?$/.exec(path);
  if (!match?.[1]) {
    return undefined;
  }
  return match[2] ? `/users/${match[1]}/statuses/${match[2]}` : `/users/${match[1]}`;
};

/** The first `Accept-Language` the build has a locale for, else English. */
const pickLocale = (header: string | undefined, available: ReadonlyArray<string>): string => {
  const known = new Set(available);
  for (const part of (header ?? "").split(",")) {
    const tag = part.split(";")[0]?.trim();
    if (!tag) continue;
    if (known.has(tag)) return tag;
    const base = tag.split("-")[0];
    if (base && known.has(base)) return base;
  }
  return "en";
};

const WEB_APP_ID = "tstodon-web";
const WEB_SCOPES = "read write follow push";

/**
 * The web app's token for a Better Auth session: derived from the session's
 * own secret, so it is never stored, and recorded (as a digest) on first use.
 */
const webAccessToken = async (
  env: Env,
  session: Readonly<{ id: string; token: string }>,
  accountId: string,
): Promise<string | undefined> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`tstodon-web-access-token:${session.token}`),
  );
  const token = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const now = new Date().toISOString();
  const stored = await runTypedBatch(env.DB, [
    ensureWebApplication(WEB_APP_ID, WEB_SCOPES, now),
    ensureWebAccessToken(
      `web:${session.id}`,
      await sha256Hex(token),
      WEB_APP_ID,
      accountId,
      WEB_SCOPES,
      session.id,
      now,
    ),
  ]);
  return stored.isOk() ? token : undefined;
};

type Viewer = Readonly<{
  account: LocalAccount;
  role: FediRoleValue;
  token: string;
}>;

/** The signed-in account behind the request's Better Auth session, if it may use the app. */
const currentViewer = async (env: Env): Promise<Viewer | undefined> => {
  const state = getSession();
  if (!state) {
    return undefined;
  }
  const account = await findAccountByAuthUserId(env.DB, state.user.id);
  if (account.isErr() || !account.value) {
    return undefined;
  }
  const [moderation, disabled] = await Promise.all([
    getAccountModeration(env.DB, account.value.id),
    disabledAccountIds(env.DB, [account.value.id]),
  ]);
  if (
    (moderation.isOk() && moderation.value === "Suspended") ||
    (disabled.isOk() && disabled.value.has(account.value.id))
  ) {
    return undefined;
  }
  const token = await webAccessToken(env, state.session, account.value.id);
  if (!token) {
    return undefined;
  }
  const role = Reflect.get(state.user, "role");
  return {
    account: account.value,
    role:
      typeof role === "string" &&
      role
        .split(",")
        .map((name) => name.trim())
        .includes("admin")
        ? FediRole.Admin
        : FediRole.User,
    token,
  };
};

const SourceSchema = z.object({
  source: z
    .object({
      privacy: z.string().optional(),
      sensitive: z.boolean().optional(),
      language: z.string().nullable().optional(),
      quote_policy: z.string().optional(),
    })
    .optional(),
});

const SettingsRowSchema = z.object({ data_json: z.string() });

const webSettings = async (env: Env, accountId: string): Promise<unknown> => {
  const rows = await runD1(() => queryTyped(env.DB, findWebSettings(accountId)));
  const row = rows.isOk() ? schemaResult(SettingsRowSchema)(rows.value[0]) : undefined;
  if (!row || row.isErr()) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(row.value.data_json);
    return parsed;
  } catch {
    return {};
  }
};

/** Mastodon's `InitialStateSerializer`, for this server's settings. */
const initialState = async (
  env: Env,
  request: Request,
  locale: string,
  viewer: Viewer | undefined,
): Promise<Record<string, unknown>> => {
  const identity = parseInstanceIdentity(env);
  const origin = new URL(request.url).origin;
  const meta: Record<string, unknown> = {
    access_token: viewer?.token ?? null,
    activity_api_enabled: true,
    admin: null,
    domain: identity.isOk() ? identity.value.domain : new URL(request.url).host,
    limited_federation_mode: await isLimitedFederation(env),
    locale,
    mascot: null,
    profile_directory: true,
    registrations_open: registrationsOpen(env),
    repository: "manji-0/tstodon",
    search_enabled: true,
    single_user_mode: false,
    source_url: identity.isOk() ? identity.value.sourceUrl : "",
    sso_redirect: null,
    status_page_url: null,
    streaming_api_base_url: origin.replace(/^http/, "ws"),
    title: identity.isOk() ? identity.value.name : "tstodon",
    landing_page: "trends",
    trends_enabled: true,
    version: "0.1.0 (compatible; tstodon)",
    terms_of_service_enabled: termsOfService(env) !== undefined,
    local_live_feed_access: "public",
    remote_live_feed_access: "public",
    local_topic_feed_access: "public",
    remote_topic_feed_access: "public",
    auto_play_gif: false,
    display_media: "default",
    reduce_motion: false,
    use_blurhash: true,
  };
  const state: Record<string, unknown> = {
    meta,
    compose: {},
    accounts: {},
    media_attachments: { accept_content_types: [...InstanceLimits.media.supportedMimeTypes] },
    settings: {},
    languages: Languages.map(([code, name]) => [code, name, name]),
    features: [],
    push_subscription: null,
  };
  if (!viewer || identity.isErr()) {
    return state;
  }
  const me = viewer.account.id;
  const [account, settings] = await Promise.all([
    credentialAccountDocument(env, identity.value, viewer.account, viewer.role),
    webSettings(env, me),
  ]);
  const source = schemaResult(SourceSchema)(account);
  const defaults = source.isOk() ? source.value.source : undefined;
  Object.assign(meta, {
    me,
    boost_modal: false,
    quick_boosting: false,
    delete_modal: true,
    missing_alt_text_modal: true,
    expand_spoilers: false,
    disable_swiping: false,
    disable_hover_cards: false,
    advanced_layout: false,
    use_pending_items: false,
    show_trends: true,
    emoji_style: "auto",
    admin: FediRole.isAdmin(viewer.role) ? me : null,
  });
  return {
    ...state,
    compose: {
      me,
      default_privacy: defaults?.privacy ?? "public",
      default_sensitive: defaults?.sensitive ?? false,
      default_language: defaults?.language ?? locale,
      default_quote_policy: defaults?.quote_policy ?? "public",
    },
    accounts: { [me]: account },
    settings,
    role: FediRole.toMastodon(viewer.role),
  };
};

const attribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** JSON inside `<script>`: nothing in it may close the element. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

const entryTags = (entry: z.infer<typeof EntrySchema>): string =>
  [
    ...entry.css.map(
      (href) => `<link rel="stylesheet" href="${attribute(href)}" crossorigin="anonymous">`,
    ),
    ...entry.preload.map(
      (href) => `<link rel="modulepreload" href="${attribute(href)}" crossorigin="anonymous">`,
    ),
    `<script type="module" src="${attribute(entry.js)}" crossorigin="anonymous"></script>`,
  ].join("\n    ");

/** The page Mastodon's `layouts/application` + `shared/_web_app` render. */
export const webAppPage = (
  manifest: WebManifest,
  options: Readonly<{
    locale: string;
    title: string;
    path: string;
    signedIn: boolean;
    vapidKey: string | null;
    state: unknown;
  }>,
): string => `<!doctype html>
<html lang="${attribute(options.locale)}" data-contrast="auto" data-color-scheme="auto" data-system-theme="true">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <script src="${attribute(manifest.themeSelection)}"></script>
    <meta name="theme-color" content="#181820" media="(prefers-color-scheme: dark)">
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
    <meta name="mobile-web-app-capable" content="yes">
    <title>${attribute(options.title)}</title>
    <link rel="stylesheet" href="${attribute(manifest.theme)}" media="all" crossorigin="anonymous">
    <script type="module" src="${attribute(manifest.polyfills)}" crossorigin="anonymous"></script>
    <link rel="stylesheet" href="${attribute(manifest.inert)}" media="all" id="inert-style" crossorigin="anonymous">
    ${entryTags(manifest.common)}
    ${options.signedIn ? `<meta name="initialPath" content="${attribute(options.path)}">` : ""}
    ${options.vapidKey ? `<meta name="applicationServerKey" content="${attribute(options.vapidKey)}">` : ""}
    <script id="initial-state" type="application/json">${scriptJson(options.state)}</script>
    ${entryTags(manifest.application)}
  </head>
  <body class="app-body">
    <div class="notranslate app-holder" id="mastodon" data-props="${attribute(JSON.stringify({ locale: options.locale }))}">
      <noscript>To use this web application, please enable JavaScript, or try one of the native apps for Mastodon.</noscript>
    </div>
  </body>
</html>`;

/**
 * Request-wide middleware: the web app's paths get the shell (once the UI is
 * built), `/web/*` redirects as in Mastodon, and `/@user` asked for as
 * ActivityPub goes to the actor or note URL.
 */
export const webAppMiddleware = async (c: Context<{ Bindings: Env }>, next: Next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return next();
  }
  const path = c.req.path;
  if (path === "/web" || path.startsWith("/web/")) {
    return c.redirect(path.slice("/web".length) || "/", 302);
  }
  if (!isWebAppPath(path)) {
    return next();
  }
  if (path.startsWith("/@") && wantsActivityJson(c.req.header("Accept"))) {
    const target = activityPubTarget(path);
    return target ? c.redirect(target, 301) : next();
  }
  const manifest = await webManifest(c.env, c.req.url);
  if (!manifest) {
    return next();
  }
  const locale = pickLocale(c.req.header("Accept-Language"), manifest.locales);
  const viewer = await currentViewer(c.env);
  const identity = parseInstanceIdentity(c.env);
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie, Accept-Language");
  return c.html(
    webAppPage(manifest, {
      locale,
      title: identity.isOk() ? identity.value.name : "tstodon",
      path,
      signedIn: viewer !== undefined,
      vapidKey: vapidPublicKey(c.env),
      state: await initialState(c.env, c.req.raw, locale, viewer),
    }),
  );
};
