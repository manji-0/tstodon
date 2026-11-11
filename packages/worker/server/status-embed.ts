import type { ApiOEmbedJSON } from "@tstodon/api";
import {
  type InstanceIdentity,
  type LocalAccount,
  type LocalNote,
  Visibility,
} from "@tstodon/domain";
import type { Context } from "hono";
import { err, ok, type Result } from "neverthrow";
import { findAccountById } from "./account-store";
import { authenticate } from "./auth";
import type { RepositoryError } from "./d1";
import { findShownStatusAnywhere } from "./found-status";
import { escapeHtml } from "./html";
import { jsonAuthError, jsonRepositoryError } from "./http";
import { parseInstanceIdentity } from "./runtime-config";

/**
 * Embedding a local status on another site, as Mastodon does: the oEmbed
 * document (`GET /api/oembed`, and `GET /api/web/embeds/:id` for the web UI's
 * "Embed" dialog), whose HTML loads `/embed.js`, which frames the status's
 * embed page (`/@user/:id/embed`, rendered by `server/web-app.ts`).
 */

/** A status Mastodon embeds: a local note, public or unlisted, its author available. */
type EmbeddableStatus = Readonly<{ account: LocalAccount; status: LocalNote }>;

/**
 * The local status with this id, when it may be embedded: Mastodon's
 * `StatusPolicy#show?` for the viewer and `distributable?`. A boost is not
 * embedded (Mastodon's embed page refuses one).
 */
const findEmbeddableStatus = async (
  env: Env,
  id: string,
  viewerId: string | undefined,
): Promise<Result<EmbeddableStatus | undefined, RepositoryError>> => {
  const found = await findShownStatusAnywhere(env, id, viewerId);
  if (found.isErr()) {
    return err(found.error);
  }
  if (
    found.value?.kind !== "LocalStatus" ||
    found.value.status.kind !== "LocalNote" ||
    Visibility.isRestricted(found.value.status.visibility)
  ) {
    return ok(undefined);
  }
  const status = found.value.status;
  const account = await findAccountById(env.DB, status.accountId);
  return account.map((author) => author && { account: author, status });
};

/** {@link findEmbeddableStatus}, when the status is `username`'s. */
export const findEmbeddableStatusOf = async (
  env: Env,
  username: string,
  id: string,
): Promise<Result<EmbeddableStatus | undefined, RepositoryError>> =>
  (await findEmbeddableStatus(env, id, undefined)).map((embeddable) =>
    embeddable?.account.username.toLowerCase() === username.toLowerCase() ? embeddable : undefined,
  );

const origin = (identity: InstanceIdentity): string => identity.publicOrigin.replace(/\/$/, "");

/** Mastodon's `short_account_status_url`: the status page in the web app. */
const statusPageUrl = (identity: InstanceIdentity, embeddable: EmbeddableStatus): string =>
  `${origin(identity)}/@${embeddable.account.username}/${embeddable.status.id}`;

/** The `href` of the status page's `<link rel="alternate" type="application/json+oembed">`. */
export const oembedDiscoveryUrl = (
  identity: InstanceIdentity,
  embeddable: EmbeddableStatus,
): string =>
  `${origin(identity)}/api/oembed?${new URLSearchParams({
    url: statusPageUrl(identity, embeddable),
    format: "json",
  }).toString()}`;

/**
 * Mastodon's `StatusFinder`: a URL on this server's origin that names a status
 * page, `/@user/:id` or `/users/user/statuses/:id`.
 */
const statusAtUrl = (
  identity: InstanceIdentity,
  raw: string,
): Readonly<{ username: string; id: string }> | undefined => {
  if (!URL.canParse(raw)) {
    return undefined;
  }
  const url = new URL(raw);
  if (url.origin !== new URL(identity.publicOrigin).origin) {
    return undefined;
  }
  const match =
    /^\/@([^/@]+)\/(\d+)\/?$/.exec(url.pathname) ??
    /^\/users\/([^/]+)\/statuses\/(\d+)\/?$/.exec(url.pathname);
  return match?.[1] && match[2] ? { username: match[1], id: match[2] } : undefined;
};

const DEFAULT_WIDTH = 400;

/** Ruby's `String#to_i`: the leading integer, else 0. */
const toI = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const FONT_FAMILY =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Oxygen, Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', Roboto, sans-serif";

const BLOCKQUOTE_STYLE =
  "background: #FCF8FF; border-radius: 8px; border: 1px solid #C9C4DA; margin: 0; max-width: 540px; min-width: 270px; overflow: hidden; padding: 0;";
const STATUS_LINK_STYLE = `align-items: center; color: #1C1A25; display: flex; flex-direction: column; font-family: ${FONT_FAMILY}; font-size: 14px; justify-content: center; letter-spacing: 0.25px; line-height: 20px; padding: 24px; text-decoration: none;`;
const ACCOUNT_STYLE = "color: #787588; margin-top: 16px;";
const VIEW_STYLE = "font-weight: 500;";

/** tstodon's mark, as `symbolPath` in `src/mastodon/tstodon/brand.ts`. */
const SYMBOL_PATH =
  "M18 4H46A14 14 0 0 1 60 18V40A14 14 0 0 1 46 54H25L12.5 62.5L13 53.08A14 14 0 0 1 4 40V18A14 14 0 0 1 18 4Z" +
  "M17 14H23V21H28V27H23V38H28V44H17V27H12V21H17Z" +
  "M32 20H52V26H38V29H52V44H32V38H46V35H32Z";

/**
 * Mastodon's `OEmbedSerializer#html` (4.3+): a link to the status that
 * `/embed.js` replaces with a frame of its embed page, for embed URLs under
 * `data-allowed-prefixes` only.
 */
const embedHtml = (identity: InstanceIdentity, embeddable: EmbeddableStatus): string => {
  const page = statusPageUrl(identity, embeddable);
  const root = `${origin(identity)}/`;
  return [
    `<blockquote class="mastodon-embed" data-embed-url="${escapeHtml(`${page}/embed`)}" style="${BLOCKQUOTE_STYLE}">`,
    `<a href="${escapeHtml(page)}" target="_blank" style="${STATUS_LINK_STYLE}">`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 64 64"><path d="${SYMBOL_PATH}" fill="currentColor" fill-rule="evenodd"/></svg>`,
    `<div style="${ACCOUNT_STYLE}">Post by @${escapeHtml(embeddable.account.username)}@${escapeHtml(identity.domain)}</div>`,
    `<div style="${VIEW_STYLE}">View on tstodon</div>`,
    `</a>`,
    `</blockquote>`,
    `<script data-allowed-prefixes="${escapeHtml(root)}" async src="${escapeHtml(`${root}embed.js`)}"></script>`,
  ].join(" ");
};

/** Mastodon's `OEmbedSerializer`, with the request's `maxwidth` / `maxheight`. */
const oembedDocument = (
  identity: InstanceIdentity,
  embeddable: EmbeddableStatus,
  size: Readonly<{ maxwidth?: string | undefined; maxheight?: string | undefined }> = {},
): ApiOEmbedJSON => ({
  type: "rich",
  version: "1.0",
  author_name: embeddable.account.displayName.trim() || embeddable.account.username,
  author_url: `${origin(identity)}/@${embeddable.account.username}`,
  provider_name: identity.domain,
  provider_url: `${origin(identity)}/`,
  cache_age: 86_400,
  html: embedHtml(identity, embeddable),
  width: size.maxwidth ? toI(size.maxwidth) : DEFAULT_WIDTH,
  height: size.maxheight ? toI(size.maxheight) : null,
});

const recordNotFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

/** `GET /api/oembed?url=…`: Mastodon's `Api::OEmbedController`, for anyone. */
export const getApiOEmbed = async (c: Context<{ Bindings: Env }, "/api/oembed">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const target = statusAtUrl(identity.value, c.req.query("url") ?? "");
  if (!target) {
    return recordNotFound(c);
  }
  const embeddable = await findEmbeddableStatusOf(c.env, target.username, target.id);
  if (embeddable.isErr()) {
    return jsonRepositoryError(c, embeddable.error.message);
  }
  if (!embeddable.value) {
    return recordNotFound(c);
  }
  return c.json(
    oembedDocument(identity.value, embeddable.value, {
      maxwidth: c.req.query("maxwidth"),
      maxheight: c.req.query("maxheight"),
    }),
  );
};

/**
 * `GET /api/web/embeds/:id`: Mastodon's `Api::Web::EmbedsController`, which
 * the web UI's "Embed" dialog reads. A remote status is a 404: Mastodon
 * fetches and sanitizes the origin server's oEmbed for a signed-in viewer,
 * but the UI offers "Embed" for local statuses only.
 */
export const getApiWebEmbedsById = async (c: Context<{ Bindings: Env }, "/api/web/embeds/:id">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const embeddable = await findEmbeddableStatus(c.env, c.req.param("id"), viewerId);
  if (embeddable.isErr()) {
    return jsonRepositoryError(c, embeddable.error.message);
  }
  if (!embeddable.value) {
    return recordNotFound(c);
  }
  return c.json(oembedDocument(identity.value, embeddable.value));
};
