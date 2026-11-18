import type { Context, Next } from "hono";
import { browserFacingOrigin } from "./browser-session";
import { parseInstanceIdentity } from "./runtime-config";
import { EMBED_CODE_STYLES } from "./status-embed";
import { webManifest } from "./web-manifest";

/** Where a policy differs from the default. */
export type PolicyOptions = Readonly<{
  /** The request's origin; the streaming socket is its `ws(s)` twin. */
  origin: string;
  /** The origin of `MEDIA_PUBLIC_BASE_URL`, when it is not this one. */
  mediaOrigin?: string | undefined;
  /** A per-response nonce the web app's inserted `<style>` elements carry. */
  styleNonce?: string | undefined;
  /** `style` attribute values allowed by hash (`'unsafe-hashes'`). */
  styleAttributeHashes?: ReadonlyArray<string>;
  /** False for a page any site may frame (a status's embed page). */
  denyFraming?: boolean;
  /**
   * False for the OAuth consent form, whose answer redirects to the client's
   * `redirect_uri`, which `form-action` would block in Chrome.
   */
  restrictFormAction?: boolean;
  /** Vite's dev server: its HMR client and React Refresh run inline code. */
  dev?: boolean;
}>;

/**
 * Mastodon's `content_security_policy.rb` (v4.7.5), with this server's
 * hosts: assets are same-origin, and remote media, avatars and emoji are
 * linked where their server put them rather than cached here, so images and
 * media come from any `https:` host (Mastodon lists only its own media hosts).
 */
export const contentSecurityPolicy = (options: PolicyOptions): string => {
  const media = ["'self'", ...(options.mediaOrigin ? [options.mediaOrigin] : [])];
  // A server on plain HTTP (local development, the e2e suites) federates
  // with others on plain HTTP; production pages are HTTPS.
  const remote = options.origin.startsWith("http:") ? ["https:", "http:"] : ["https:"];
  const streaming = options.origin.replace(/^http/, "ws");
  // In development `'unsafe-inline'` allows every style; a nonce or a hash
  // would switch it off.
  const styles = options.dev
    ? ["'unsafe-inline'"]
    : [
        ...(options.styleNonce ? [`'nonce-${options.styleNonce}'`] : []),
        ...(options.styleAttributeHashes?.length
          ? ["'unsafe-hashes'", ...options.styleAttributeHashes.map((hash) => `'${hash}'`)]
          : []),
      ];
  const directives: ReadonlyArray<readonly [string, ...string[]]> = [
    ["base-uri", "'none'"],
    ["default-src", "'none'"],
    ...(options.denyFraming === false ? [] : [["frame-ancestors", "'none'"] as const]),
    ["font-src", "'self'"],
    ["img-src", ...media, "data:", "blob:", ...remote],
    ["media-src", ...media, "data:", "blob:", ...remote],
    ["manifest-src", "'self'"],
    ...(options.restrictFormAction === false ? [] : [["form-action", "'self'"] as const]),
    ["child-src", "'self'", "blob:"],
    ["worker-src", "'self'", "blob:"],
    ["connect-src", "'self'", "data:", "blob:", ...media.slice(1), streaming],
    [
      "script-src",
      "'self'",
      "'wasm-unsafe-eval'",
      ...(options.dev ? ["'unsafe-inline'", "'unsafe-eval'"] : []),
    ],
    ["frame-src", "'self'", "https:"],
    ["style-src", "'self'", ...styles],
  ];
  return directives.map((directive) => directive.join(" ")).join("; ");
};

const sha256Source = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
};

let embedCodeStyleHashes: Promise<ReadonlyArray<string>> | undefined;

/**
 * The hashes of the embed code's `style` attributes. The web UI's "Get embed
 * code" preview writes that code into a frame that inherits the shell's
 * policy; Mastodon's own policy blocks these styles there.
 */
export const embedCodeStyleSources = (): Promise<ReadonlyArray<string>> => {
  embedCodeStyleHashes ??= Promise.all(EMBED_CODE_STYLES.map(sha256Source));
  return embedCodeStyleHashes;
};

/** A fresh nonce for one response: 16 random bytes, base64, as Mastodon's. */
export const newStyleNonce = (): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));

/** The policy options this request and deployment imply. */
export const policyOptions = (c: Context<{ Bindings: Env }>): PolicyOptions => {
  // The origin the browser sees, as the shell's `streaming_api_base_url` uses.
  const origin = browserFacingOrigin(c.req.url, c.req.header("X-Forwarded-Proto"));
  const identity = parseInstanceIdentity(c.env);
  const media = identity.isOk() ? URL.parse(identity.value.mediaPublicBaseUrl)?.origin : undefined;
  return {
    origin,
    mediaOrigin: media !== undefined && media !== origin ? media : undefined,
    dev: webManifest.dev,
    restrictFormAction: c.req.path !== "/oauth/authorize",
  };
};

/**
 * Request-wide: every answer is `nosniff` and, unless its route chose
 * another, `same-origin` referrer; an HTML page carries the default policy unless its route set its own (the
 * web app shell, for its nonce; the embed page, which any site may frame).
 * `X-Frame-Options: DENY` goes with a policy that forbids framing. Other
 * answers get no policy: a script's would bind the worker it starts (the
 * service worker fetches remote media), and Mastodon serves its static files
 * without one. The WebSocket handshake (101) is left as it is. HSTS is left
 * to Cloudflare's edge (SSL/TLS settings), which adds it to every response
 * of the zone.
 */
export const securityHeadersMiddleware = async (
  c: Context<{ Bindings: Env }>,
  next: Next,
): Promise<void> => {
  await next();
  if (c.res.status === 101) {
    return;
  }
  if (!c.res.headers.has("Referrer-Policy")) {
    c.header("Referrer-Policy", "same-origin");
  }
  c.header("X-Content-Type-Options", "nosniff");
  if (!(c.res.headers.get("Content-Type") ?? "").toLowerCase().startsWith("text/html")) {
    return;
  }
  const policy =
    c.res.headers.get("Content-Security-Policy") ?? contentSecurityPolicy(policyOptions(c));
  c.header("Content-Security-Policy", policy);
  if (policy.includes("frame-ancestors 'none'")) {
    c.header("X-Frame-Options", "DENY");
  }
};
