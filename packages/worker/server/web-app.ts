import type { Context, Next } from "hono";
import { z } from "zod";
import { InstanceLimits, Languages, schemaResult } from "@tstodon/core";
import {
  type ApiInitialStateJSON,
  type ApiInitialStateMetaJSON,
  ApiWebSettings,
  type ApiWebSettingsJSON,
} from "@tstodon/api";
import { FediRole, type FediRole as FediRoleValue, type LocalAccount } from "@tstodon/domain";
import { type Appearance, DEFAULT_APPEARANCE, findAppearance, themeColorMetas } from "./appearance";
import { browserFacingOrigin, browserSession } from "./browser-session";
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
import { parseJsonText } from "./json-column";
import { findTokenPushSubscription } from "./push-subscription-store";
import { subscriptionDocument } from "./routes/push";
import { WEB_APP_ID, webAccessTokenId } from "./web-token";
import { findEmbeddableStatusOf, oembedDiscoveryUrl } from "./status-embed";
import { type WebEntry, type WebManifest, webManifest } from "./web-manifest";

export type { WebManifest } from "./web-manifest";

/**
 * Mastodon's own web UI, the client of this Void app (`src/`), served as
 * Workers Assets (`/packs`, `/emoji`, `/sounds`, `/sw.js`). The Worker plays
 * the part of Mastodon's Rails layout: it serves the HTML shell on the web
 * app's paths with the `initial-state` document the UI boots from. A
 * signed-in Better Auth session gets an access token of the built-in web app,
 * derived from the session and removed with it.
 */

/** Paths Mastodon routes to its React app (`config/routes/web_app.rb` and friends). */
const WEB_APP_PATHS: ReadonlyArray<RegExp> = [
  /^\/$/,
  /^\/(?:about|blocks|bookmarks|conversations|directory|domain_blocks|favourites|follow_requests|followed_tags|getting-started|home|keyboard-shortcuts|mutes|overview|overview\/about|pinned|privacy-policy|public|public\/local|public\/remote|publish|search|terms-of-service)$/,
  /^\/(?:collections|deck|explore|links|lists|notifications|notifications_v2|profile|start|statuses|tags|terms-of-service)(?:\/.*)?$/,
  /^\/@[^/]+(?:\/.*)?$/,
];

export const isWebAppPath = (path: string): boolean =>
  WEB_APP_PATHS.some((pattern) => pattern.test(path));

/** A Vite output file: its name ends in an 8-character content hash. */
const HASHED_PACK = /^\/packs\/(?:[^/]+\/)*[^/]+-[\w-]{8}\.\w+$/;

/**
 * The Cache-Control for a static asset, when it differs from the platform's
 * revalidate-every-time default. A content-hashed pack never changes under
 * its name, so a browser keeps it instead of revalidating the app's ~180
 * modules (each a Worker invocation) on every page load. Fixed-name files
 * (`/sw.js`, `/emoji/*`, …) keep the default.
 */
export const packCacheControl = (pathname: string): string | undefined =>
  HASHED_PACK.test(pathname) ? "private, max-age=31536000, immutable" : undefined;

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

const WEB_SCOPES = "read write follow push";

/**
 * The web app's token for an Access login: derived from that login's session
 * secret, so it is never stored, and recorded (as a digest) on first use.
 */
const webAccessToken = async (
  env: Env,
  session: Readonly<{ id: string; token: string }>,
  accountId: string,
): Promise<Readonly<{ id: string; token: string }> | undefined> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`tstodon-web-access-token:${session.token}`),
  );
  const token = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const id = webAccessTokenId(session.id);
  const now = new Date().toISOString();
  const stored = await runTypedBatch(env.DB, [
    ensureWebApplication(WEB_APP_ID, WEB_SCOPES, now),
    ensureWebAccessToken(
      id,
      await sha256Hex(token),
      WEB_APP_ID,
      accountId,
      WEB_SCOPES,
      session.id,
      now,
    ),
  ]);
  return stored.isOk() ? { id, token } : undefined;
};

type Viewer = Readonly<{
  account: LocalAccount;
  role: FediRoleValue;
  token: string;
  /** The access token's id, which the session's Web Push subscription is stored under. */
  tokenId: string;
}>;

/** The signed-in account behind the request's Better Auth session, if it may use the app. */
const currentViewer = async (request: Request, env: Env): Promise<Viewer | undefined> => {
  const viewer = await browserSession(request, env);
  if (viewer.kind !== "Account") {
    return undefined;
  }
  const token = await webAccessToken(
    env,
    { id: viewer.sessionId, token: viewer.sessionToken },
    viewer.account.id,
  );
  return token
    ? { account: viewer.account, role: viewer.role, token: token.token, tokenId: token.id }
    : undefined;
};

const SettingsRowSchema = z.object({ data_json: z.string() });

const parseWebSettings = schemaResult(ApiWebSettings);

/** The viewer's stored web UI settings, `{}` when none are stored or they are not an object. */
const webSettings = async (env: Env, accountId: string): Promise<ApiWebSettingsJSON> => {
  const rows = await runD1(() => queryTyped(env.DB, findWebSettings(accountId), SettingsRowSchema));
  const row = rows.isOk() ? rows.value[0] : undefined;
  if (row === undefined) {
    return {};
  }
  return parseJsonText(row.data_json)
    .andThen((data) => parseWebSettings(data))
    .unwrapOr({});
};

/**
 * Mastodon's `InitialStateSerializer`, for this server's settings. Where
 * Mastodon reads a setting tstodon does not have, the value is Mastodon's
 * default; `admin` is the site contact account, which tstodon does not
 * configure (`contact.account` is `null` on `/api/v2/instance` too).
 */
export const initialState = async (
  env: Env,
  request: Request,
  locale: string,
  viewer: Viewer | undefined,
): Promise<ApiInitialStateJSON> => {
  const identity = parseInstanceIdentity(env);
  // The stream is on the host that served this page, which is not
  // INSTANCE_PUBLIC_ORIGIN under `pnpm dev` (that defaults to https://example.com).
  const origin = browserFacingOrigin(
    request.url,
    request.headers.get("X-Forwarded-Proto") ?? undefined,
  );
  const meta: ApiInitialStateMetaJSON = {
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
  const state: ApiInitialStateJSON = {
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
  const [account, settings, push] = await Promise.all([
    credentialAccountDocument(env, identity.value, viewer.account, viewer.role),
    webSettings(env, me),
    findTokenPushSubscription(env.DB, viewer.tokenId),
  ]);
  const moved = account.moved ?? undefined;
  return {
    ...state,
    meta: {
      ...meta,
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
      ...(moved ? { moved_to_account_id: moved.id } : {}),
    },
    compose: {
      me,
      default_privacy: account.source.privacy,
      default_sensitive: account.source.sensitive,
      default_language: account.source.language ?? locale,
      default_quote_policy: account.source.quote_policy,
    },
    accounts: { [me]: account, ...(moved ? { [moved.id]: moved } : {}) },
    settings,
    // The session's subscription, so the UI keeps it instead of subscribing again.
    push_subscription: push.isOk() && push.value ? subscriptionDocument(env, push.value) : null,
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

/**
 * Vite's own paths on the dev server (its HMR client, React Refresh, modules
 * outside the root); `/@vite/client` would otherwise look like a profile.
 */
const VITE_DEV_PATH = /^\/@(?:vite|id|fs|react-refresh)(?:\/|$)/;

export const entryTags = (entry: WebEntry): string =>
  [
    ...entry.css.map(
      (href) => `<link rel="stylesheet" href="${attribute(href)}" crossorigin="anonymous">`,
    ),
    ...entry.preload.map(
      (href) => `<link rel="modulepreload" href="${attribute(href)}" crossorigin="anonymous">`,
    ),
    `<script type="module" src="${attribute(entry.js)}" crossorigin="anonymous"></script>`,
  ].join("\n    ");

/** Vite's HMR client and the React Refresh preamble, as `vite_ruby` adds them in development. */
const devTags = (manifest: WebManifest): string =>
  [
    manifest.devPreamble ? `<script type="module">${manifest.devPreamble}</script>` : "",
    `<script type="module" src="/@vite/client"></script>`,
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
    /** The viewer's colour scheme and contrast; `auto` for a signed-out visitor. */
    appearance: Appearance;
    /** A status page's oEmbed endpoint (`<link rel="alternate" type="application/json+oembed">`). */
    oembedUrl?: string | undefined;
  }>,
): string => `<!doctype html>
<html lang="${attribute(options.locale)}" data-contrast="${options.appearance.contrast}" data-color-scheme="${options.appearance.colorScheme}"${options.appearance.colorScheme === "auto" ? ' data-system-theme="true"' : ""}>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    ${manifest.dev ? devTags(manifest) : ""}
    <script${manifest.dev ? ' type="module"' : ""} src="${attribute(manifest.themeSelection)}"></script>
    ${themeColorMetas(options.appearance.colorScheme)}
    <meta name="mobile-web-app-capable" content="yes">
    <title>${attribute(options.title)}</title>
    ${options.oembedUrl ? `<link rel="alternate" type="application/json+oembed" href="${attribute(options.oembedUrl)}">` : ""}
    <link rel="icon" type="image/png" sizes="32x32" href="${attribute(manifest.favicon)}">
    <link rel="stylesheet" href="${attribute(manifest.theme)}" media="all" crossorigin="anonymous">
    ${manifest.polyfills ? `<script type="module" src="${attribute(manifest.polyfills)}" crossorigin="anonymous"></script>` : ""}
    <link rel="stylesheet" href="${attribute(manifest.inert)}" media="all" id="inert-style" crossorigin="anonymous">
    ${entryTags(manifest.common)}
    ${options.signedIn ? `<meta name="initialPath" content="${attribute(options.path)}">` : ""}
    ${options.vapidKey ? `<meta name="applicationServerKey" content="${attribute(options.vapidKey)}">` : ""}
    <script id="initial-state" type="application/json">${scriptJson(options.state)}</script>
    ${entryTags(manifest.application)}
  </head>
  <body class="app-body">
    <div class="notranslate app-holder" id="mastodon" data-props="${attribute(JSON.stringify({ locale: options.locale }))}">
      <noscript>To use tstodon's web app, please enable JavaScript, or use an app that works with Mastodon-compatible servers.</noscript>
    </div>
  </body>
</html>`;

/**
 * The page an embedded status frames: Mastodon's `statuses/embed` in its
 * `embedded` layout, booting the `embed` pack with a signed-out initial state
 * (any site may frame it, so it carries no viewer's token).
 */
const embedPage = (
  manifest: WebManifest,
  options: Readonly<{ locale: string; statusId: string; state: unknown }>,
): string => `<!doctype html>
<html lang="${attribute(options.locale)}" data-contrast="auto" data-color-scheme="light">
  <head>
    <meta charset="utf-8">
    <meta name="robots" content="noindex">
    ${manifest.dev ? devTags(manifest) : ""}
    <script${manifest.dev ? ' type="module"' : ""} src="${attribute(manifest.themeSelection)}"></script>
    ${manifest.polyfills ? `<script type="module" src="${attribute(manifest.polyfills)}" crossorigin="anonymous"></script>` : ""}
    <link rel="stylesheet" href="${attribute(manifest.theme)}" media="all" crossorigin="anonymous">
    <script id="initial-state" type="application/json">${scriptJson(options.state)}</script>
    ${entryTags(manifest.embed)}
  </head>
  <body class="embed">
    <div id="mastodon-status" data-props="${attribute(JSON.stringify({ locale: options.locale, id: options.statusId }))}"></div>
  </body>
</html>`;

/** `/@alice/123/embed`: a status's embed page. */
const EMBED_PATH = /^\/@([^/@]+)\/(\d+)\/embed\/?$/;

/** `/@alice/123`: a local status's page. */
const STATUS_PATH = /^\/@([^/@]+)\/(\d+)\/?$/;

const statusEmbedPage = async (
  c: Context<{ Bindings: Env }>,
  username: string,
  statusId: string,
): Promise<Response> => {
  const embeddable = await findEmbeddableStatusOf(c.env, username, statusId);
  if (embeddable.isErr()) {
    return c.text("Internal Server Error", 500);
  }
  if (!embeddable.value) {
    return c.text("Not Found", 404);
  }
  const locale = pickLocale(c.req.header("Accept-Language"), webManifest.locales);
  // Mastodon's `StatusesController#embed`: cacheable, and framed by any site.
  c.header("Cache-Control", "public, max-age=180");
  c.header("Vary", "Accept-Language");
  return c.html(
    embedPage(webManifest, {
      locale,
      statusId: embeddable.value.status.id,
      state: await initialState(c.env, c.req.raw, locale, undefined),
    }),
  );
};

/** The oEmbed endpoint a status page advertises, when the path is an embeddable status's. */
const statusPageOEmbedUrl = async (env: Env, path: string): Promise<string | undefined> => {
  const match = STATUS_PATH.exec(path);
  const identity = parseInstanceIdentity(env);
  if (!match?.[1] || !match[2] || identity.isErr()) {
    return undefined;
  }
  const embeddable = await findEmbeddableStatusOf(env, match[1], match[2]);
  return embeddable.isOk() && embeddable.value
    ? oembedDiscoveryUrl(identity.value, embeddable.value)
    : undefined;
};

/**
 * Request-wide middleware: the web app's paths get the shell, `/web/*` redirects as in Mastodon, `/@user` asked for as
 * ActivityPub goes to the actor or note URL, and the `/favicon.ico` every
 * browser asks for goes to the build's hashed favicon.
 */
export const webAppMiddleware = async (c: Context<{ Bindings: Env }>, next: Next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return next();
  }
  const path = c.req.path;
  if (path === "/web" || path.startsWith("/web/")) {
    return c.redirect(path.slice("/web".length) || "/", 302);
  }
  if (path === "/favicon.ico") {
    return c.redirect(webManifest.favicon, 302);
  }
  if (!isWebAppPath(path) || (webManifest.dev && VITE_DEV_PATH.test(path))) {
    return next();
  }
  const embed = EMBED_PATH.exec(path);
  if (embed?.[1] && embed[2]) {
    return statusEmbedPage(c, embed[1], embed[2]);
  }
  if (path.startsWith("/@") && wantsActivityJson(c.req.header("Accept"))) {
    const target = activityPubTarget(path);
    return target ? c.redirect(target, 301) : next();
  }
  const manifest = webManifest;
  const locale = pickLocale(c.req.header("Accept-Language"), manifest.locales);
  const viewer = await currentViewer(c.req.raw, c.env);
  const identity = parseInstanceIdentity(c.env);
  const [state, appearance, oembedUrl] = await Promise.all([
    initialState(c.env, c.req.raw, locale, viewer),
    viewer === undefined
      ? DEFAULT_APPEARANCE
      : findAppearance(c.env.DB, viewer.account.id).then((found) =>
          found.unwrapOr(DEFAULT_APPEARANCE),
        ),
    statusPageOEmbedUrl(c.env, path),
  ]);
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie, Accept-Language, Cf-Access-Jwt-Assertion");
  return c.html(
    webAppPage(manifest, {
      locale,
      title: identity.isOk() ? identity.value.name : "tstodon",
      path,
      signedIn: viewer !== undefined,
      vapidKey: vapidPublicKey(c.env),
      state,
      appearance,
      oembedUrl,
    }),
  );
};
