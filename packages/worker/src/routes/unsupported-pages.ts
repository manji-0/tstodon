import type { Context } from "hono";
import { type UnsupportedNotice, unsupportedPage } from "../settings-pages";
import { instanceName } from "./account-settings";

/**
 * Rails pages of Mastodon that its web app links to and this server has no
 * counterpart for. Each answers a page that says so, in place of a bare 404
 * from the asset fallback.
 */
const NOTICES = {
  filters: {
    title: "Muted words",
    text: 'Filters still work on this server: in the web app, choose "Filter this post" from a post\'s menu, or use an app that manages filters.',
    alternatives: [],
  },
  statusesCleanup: {
    title: "Automated post deletion",
    text: "This server does not delete old posts automatically. You can delete a post from its menu in the web app.",
    alternatives: [],
  },
  accountSecurity: {
    title: "Password and security",
    text: "This server signs in with passkeys instead of passwords, and has no page to manage them yet. To sign out, use Logout in the web app's menu.",
    alternatives: [],
  },
  importExport: {
    title: "Import and export",
    text: "This server cannot export or import follows, lists, or blocks as files yet. To take your followers to another account, use account migration.",
    alternatives: [
      { href: "/settings/migration", label: "Move to a different account" },
      { href: "/settings/aliases", label: "Moving from a different account" },
    ],
  },
  administration: {
    title: "Administration",
    text: "This server has no admin web pages. Admins and moderators use Mastodon's admin API (/api/v1/admin) from an app that supports it.",
    alternatives: [],
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
    c.html(unsupportedPage(instanceName(c.env), notice), 404);

export const getFilters = unsupported(NOTICES.filters);
export const getStatusesCleanup = unsupported(NOTICES.statusesCleanup);
export const getAuthEdit = unsupported(NOTICES.accountSecurity);
export const getSettingsExport = unsupported(NOTICES.importExport);
export const getAdmin = unsupported(NOTICES.administration);
export const getSeveredRelationships = unsupported(NOTICES.severedRelationships);
export const getDisputes = unsupported(NOTICES.disputes);
export const getUnknownSettings = unsupported(NOTICES.settings);
