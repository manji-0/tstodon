import type { Context } from "hono";
import { type UnsupportedNotice, unsupportedPage } from "../settings-pages";
import { instanceName } from "./account-settings";

/**
 * Rails pages of Mastodon that its web app links to and this server has no
 * counterpart for. Each answers a page that says so, with status 200: Void's
 * SPA fallback replaces a 404 to a browser navigation with `index.html`.
 */
const NOTICES = {
  administration: {
    title: "Administration",
    text: "This server's admin pages cover the dashboard, reports, accounts, federation, announcements, custom emojis, trends, and email domain blocks. For anything else, use Mastodon's admin API (/api/v1/admin) from an app that supports it.",
    alternatives: [
      { href: "/admin/dashboard", label: "Dashboard" },
      { href: "/admin/reports", label: "Reports" },
      { href: "/admin/accounts", label: "Accounts" },
      { href: "/admin/instances", label: "Federation" },
      { href: "/admin/announcements", label: "Announcements" },
      { href: "/admin/custom_emojis", label: "Custom emojis" },
      { href: "/admin/trends/tags", label: "Trends" },
      { href: "/admin/email_domain_blocks", label: "Email domain blocks" },
    ],
  },
  severedRelationships: {
    title: "Severed relationships",
    text: "This server does not keep lists of the follows that a server block removed.",
    alternatives: [],
  },
  disputes: {
    title: "Moderation decisions",
    text: "Appeals are not available on this server. Contact the server's administrators.",
    alternatives: [],
  },
  settings: {
    title: "Settings",
    text: "This setting is not available on this server. The preferences page lists the settings it has.",
    alternatives: [{ href: "/settings/preferences", label: "Preferences" }],
  },
} as const satisfies Record<string, UnsupportedNotice>;

const unsupported =
  (notice: UnsupportedNotice) =>
  (c: Context<{ Bindings: Env }>): Response | Promise<Response> =>
    c.html(unsupportedPage(instanceName(c.env), notice));

export const getUnknownAdmin = unsupported(NOTICES.administration);
export const getSeveredRelationships = unsupported(NOTICES.severedRelationships);
export const getDisputes = unsupported(NOTICES.disputes);
export const getUnknownSettings = unsupported(NOTICES.settings);
