import { Languages } from "@tstodon/core";
import {
  type InteractionThreshold,
  MIN_AGE_CHOICES,
  type StatusesCleanupPolicyValue,
} from "@tstodon/domain";
import type { AccountAlias } from "./account-alias-store";
import { page, PASSKEY_SIGN_IN, WEBAUTHN_HELPERS } from "./auth-pages";
import { escapeHtml } from "./html";

/**
 * Account settings that Mastodon keeps in Rails pages, not in its web app:
 * the settings index (`/settings/preferences`), posting defaults, privacy
 * and reach, passkeys and sessions (`/auth/edit`, in `account-security-pages.ts`), the "moving from" aliases (`/settings/aliases`) and the move to
 * another account (`/settings/migration`). Plain forms in the style of the
 * sign-in pages, posted back to this origin with the session cookie.
 */

export type PageMessage = Readonly<{ kind: "error" | "notice"; text: string }>;

export const nav = `      <p class="muted"><a href="/">Back to the web app</a> · <a href="/settings/preferences">Preferences</a></p>`;

type Link = Readonly<{ href: string; label: string }>;

const linkList = (links: ReadonlyArray<Link & { about?: string }>): string =>
  `<ul>${links
    .map(
      (link) => `
        <li><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>${link.about === undefined ? "" : ` <span class="muted">${escapeHtml(link.about)}</span>`}</li>`,
    )
    .join("")}
      </ul>`;

const SETTINGS_SECTIONS: ReadonlyArray<
  Readonly<{ heading: string; links: ReadonlyArray<Link & { about: string }> }>
> = [
  {
    heading: "Profile",
    links: [
      { href: "/profile/edit", label: "Edit profile", about: "Name, bio, fields, and pictures." },
      {
        href: "/settings/privacy",
        label: "Privacy and reach",
        about: "Follow requests, discovery, and search.",
      },
    ],
  },
  {
    heading: "Posting",
    links: [
      {
        href: "/settings/preferences/posting_defaults",
        label: "Posting defaults",
        about: "Visibility, quotes, media, and language of new posts.",
      },
      {
        href: "/statuses_cleanup",
        label: "Automated post deletion",
        about: "Delete your old posts automatically.",
      },
    ],
  },
  {
    heading: "Accounts and hashtags",
    links: [
      { href: "/follow_requests", label: "Follow requests", about: "Accounts waiting for you." },
      { href: "/mutes", label: "Muted users", about: "Accounts you do not see." },
      { href: "/blocks", label: "Blocked users", about: "Accounts that cannot reach you." },
      { href: "/domain_blocks", label: "Blocked domains", about: "Servers you do not see." },
      { href: "/followed_tags", label: "Followed hashtags", about: "Hashtags in your home feed." },
      { href: "/filters", label: "Filters", about: "Hide posts with certain words." },
    ],
  },
  {
    heading: "Account and security",
    links: [
      {
        href: "/auth/edit",
        label: "Password and security",
        about: "Passkeys, browser sessions, and apps that can use your account.",
      },
      {
        href: "/severed_relationships",
        label: "Severed relationships",
        about: "Follows lost when a server or account was suspended.",
      },
    ],
  },
  {
    heading: "Import and export",
    links: [
      {
        href: "/settings/export",
        label: "Export",
        about: "Download your follows, lists, blocks, mutes, and bookmarks.",
      },
      {
        href: "/settings/import",
        label: "Import",
        about: "Upload them from Mastodon or another server.",
      },
    ],
  },
  {
    heading: "Account migration",
    links: [
      {
        href: "/settings/aliases",
        label: "Moving from a different account",
        about: "Let another account move its followers here.",
      },
      {
        href: "/settings/migration",
        label: "Move to a different account",
        about: "Send your followers to another account.",
      },
    ],
  },
];

const ADMIN_SECTION = {
  heading: "Administration",
  links: [
    { href: "/admin/reports", label: "Reports", about: "Reports from users, and actions on them." },
    { href: "/admin/accounts", label: "Accounts", about: "Approve, limit, or suspend accounts." },
    { href: "/admin/instances", label: "Federation", about: "Limit or suspend other servers." },
  ],
} as const;

/** The settings this server has, grouped like Mastodon's settings sidebar. */
export const settingsIndexPage = (
  instanceName: string,
  username: string,
  isAdmin: boolean,
): string =>
  page(
    `Preferences · ${instanceName}`,
    `      <p class="muted"><a href="/">Back to the web app</a></p>
      <h1>Preferences</h1>
      <p>Settings for <strong>@${escapeHtml(username)}</strong>.</p>${[
        ...SETTINGS_SECTIONS,
        ...(isAdmin ? [ADMIN_SECTION] : []),
      ]
        .map(
          (section) => `
      <h2>${escapeHtml(section.heading)}</h2>
      ${linkList(section.links)}`,
        )
        .join("")}`,
  );

export const messageLine = (message: PageMessage | undefined): string =>
  `      <p id="error" class="${message?.kind === "notice" ? "muted" : "error"}" role="alert">${message === undefined ? "" : escapeHtml(message.text)}</p>`;

export const aliasesPage = (
  instanceName: string,
  username: string,
  aliases: ReadonlyArray<AccountAlias>,
  message?: PageMessage,
): string =>
  page(
    `Moving from a different account · ${instanceName}`,
    `${nav}
      <h1>Moving from a different account</h1>
      <p>To move your followers from another account to <strong>@${escapeHtml(username)}</strong>, add the old account here first. Then start the move from the old account.</p>
      <form method="post" action="/settings/aliases">
        <label for="acct">Handle of the old account</label>
        <input id="acct" name="acct" required placeholder="username@domain" autocomplete="off" />
        <button type="submit">Create alias</button>
      </form>
${messageLine(message)}
      <h2>Aliases</h2>
      ${
        aliases.length === 0
          ? `<p class="muted">No aliases yet.</p>`
          : `<ul>${aliases
              .map(
                (alias) => `
        <li><code>${escapeHtml(alias.acct)}</code>
          <form method="post" action="/settings/aliases/remove">
            <input type="hidden" name="id" value="${escapeHtml(alias.id)}" />
            <button type="submit">Unlink alias</button>
          </form>
        </li>`,
              )
              .join("")}
      </ul>`
      }`,
  );

export type MigrationState = Readonly<{
  /** The handle of the account this one moved to, if it moved. */
  movedTo: string | undefined;
  /** When the account may move somewhere else; `undefined` when it may now. */
  nextMoveAt: Date | undefined;
  /** Whether the session is too old to move without signing in again. */
  reauthRequired: boolean;
}>;

/**
 * Mastodon's `/settings/migration`. Moving needs a recent sign-in: when the
 * session is older than that, the form signs in again with the passkey
 * before it posts.
 */
export const migrationPage = (
  instanceName: string,
  username: string,
  state: MigrationState,
  message?: PageMessage,
): string =>
  page(
    `Move to a different account · ${instanceName}`,
    `${nav}
      <h1>Move to a different account</h1>${
        state.movedTo === undefined
          ? ""
          : `
      <p><strong>@${escapeHtml(username)}</strong> has moved to <strong>${escapeHtml(state.movedTo)}</strong> and can no longer post.</p>
      <form id="cancel-move" method="post" action="/settings/migration/cancel">
        <button type="submit">Cancel redirect</button>
      </form>
      <p class="muted">Cancelling stops the redirect. Followers who already moved stay with the new account, and moving again has to wait out the cooldown.</p>`
      }
      <p>Moving sends your followers to the new account. First add <code>@${escapeHtml(username)}</code> as an alias on the new account, under "Moving from a different account". Your posts and the accounts you follow stay here.</p>
      ${
        state.nextMoveAt === undefined
          ? `<form id="move" method="post" action="/settings/migration">
        <label for="acct">Handle of the new account</label>
        <input id="acct" name="acct" required placeholder="username@domain" autocomplete="off" />
        <button type="submit">Move followers</button>
      </form>${state.reauthRequired ? `\n      <p class="muted">You confirm with your passkey before the move starts.</p>` : ""}`
          : `<p class="muted">You can move to a different account again after ${escapeHtml(state.nextMoveAt.toISOString())}.</p>`
      }
${messageLine(message)}`,
    state.nextMoveAt === undefined && state.reauthRequired
      ? `${WEBAUTHN_HELPERS}${PASSKEY_SIGN_IN}
      document.getElementById("move").addEventListener("submit", async (event) => {
        event.preventDefault();
        show("");
        if (await signInWithPasskey()) event.target.submit();
      });`
      : "",
  );

export const options = (
  choices: ReadonlyArray<readonly [value: string, label: string]>,
  selected: string,
): string =>
  choices
    .map(
      ([value, label]) =>
        `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`,
    )
    .join("");

export const checkbox = (
  id: string,
  checked: boolean,
  label: string,
  hint: string,
): string => `<p class="check"><input type="checkbox" id="${id}" name="${id}" value="1"${checked ? " checked" : ""} />
        <label for="${id}">${escapeHtml(label)} <span class="muted">${escapeHtml(hint)}</span></label></p>`;

export type PostingDefaults = Readonly<{
  privacy: "public" | "unlisted" | "private" | "direct";
  quotePolicy: "public" | "followers" | "nobody";
  sensitive: boolean;
  /** A language code, or `""` for none. */
  language: string;
}>;

/** Mastodon's `/settings/preferences/posting_defaults`: the account's `source` defaults. */
export const postingDefaultsPage = (
  instanceName: string,
  defaults: PostingDefaults,
  message?: PageMessage,
): string =>
  page(
    `Posting defaults · ${instanceName}`,
    `${nav}
      <h1>Posting defaults</h1>
      <p>New posts start with these settings. You can still change them on each post.</p>
      <form method="post" action="/settings/preferences/posting_defaults">
        <label for="privacy">Visibility</label>
        <select id="privacy" name="privacy">${options(
          [
            ["public", "Public"],
            ["unlisted", "Quiet public"],
            ["private", "Followers only"],
            ["direct", "Private mention"],
          ],
          defaults.privacy,
        )}</select>
        <label for="quote_policy">Who can quote</label>
        <select id="quote_policy" name="quote_policy">${options(
          [
            ["public", "Anyone"],
            ["followers", "Followers only"],
            ["nobody", "Just me"],
          ],
          defaults.quotePolicy,
        )}</select>
        <label for="language">Language</label>
        <select id="language" name="language">${options(
          [["", "Not set"], ...Languages],
          defaults.language,
        )}</select>
        ${checkbox("sensitive", defaults.sensitive, "Always mark media as sensitive", "Viewers click to see it.")}
        <button type="submit">Save changes</button>
      </form>
${messageLine(message)}`,
  );

export type PrivacySettings = Readonly<{
  locked: boolean;
  discoverable: boolean;
  indexable: boolean;
  hideCollections: boolean;
}>;

/**
 * Mastodon's `/settings/privacy`. The checkbox ids are Mastodon's, since the
 * web app links to `#account_unlocked` and `#account_discoverable`.
 */
export const privacyPage = (
  instanceName: string,
  settings: PrivacySettings,
  message?: PageMessage,
): string =>
  page(
    `Privacy and reach · ${instanceName}`,
    `${nav}
      <h1>Privacy and reach</h1>
      <form method="post" action="/settings/privacy">
        ${checkbox("account_unlocked", !settings.locked, "Automatically accept new followers", "Turn this off to review follow requests yourself.")}
        ${checkbox("account_discoverable", settings.discoverable, "Feature profile and posts in discovery", "Your profile can appear in suggestions and the directory.")}
        ${checkbox("account_indexable", settings.indexable, "Include public posts in search results", "People can find your public posts by searching.")}
        ${checkbox("account_show_collections", !settings.hideCollections, "Show who you follow and who follows you", "Visible on your profile.")}
        <button type="submit">Save changes</button>
      </form>
${messageLine(message)}`,
  );

export type UnsupportedNotice = Readonly<{
  title: string;
  /** What the server offers instead, or why it has no such page. */
  text: string;
  alternatives: ReadonlyArray<Link>;
}>;

/** A Mastodon page this server has no counterpart for: say so and offer a way on. */
export const unsupportedPage = (instanceName: string, notice: UnsupportedNotice): string =>
  page(
    `${notice.title} · ${instanceName}`,
    `${nav}
      <h1>${escapeHtml(notice.title)}</h1>
      <p><strong>This page is not available on this server.</strong> ${escapeHtml(notice.text)}</p>${
        notice.alternatives.length === 0
          ? ""
          : `
      ${linkList(notice.alternatives)}`
      }`,
  );

/** Mastodon's `/statuses_cleanup`: delete old posts automatically, unless a keep rule protects them. */
export const statusesCleanupPage = (
  instanceName: string,
  policy: StatusesCleanupPolicyValue,
  message?: PageMessage,
): string => {
  const rules = policy.rules;
  const count = (threshold: InteractionThreshold): string =>
    threshold.kind === "AtLeast" ? String(threshold.count) : "";
  return page(
    `Automated post deletion · ${instanceName}`,
    `${nav}
      <h1>Automated post deletion</h1>
      <p>Delete your old posts automatically once they reach an age you choose, unless one of the exceptions below applies. Deleted posts also leave other servers that received them.</p>
      <form method="post" action="/statuses_cleanup">
        ${checkbox("enabled", policy.kind === "Enabled", "Enable automatic deletion of posts", "Posts are deleted a few at a time, so it can take a while.")}
        <label for="min_status_age">Age threshold</label>
        <select id="min_status_age" name="min_status_age">${options(
          MIN_AGE_CHOICES.map((choice) => [String(choice.seconds), choice.label]),
          String(rules.minAgeSeconds),
        )}</select>
        <h2>Exceptions</h2>
        ${checkbox("keep_pinned", rules.keepPinned, "Keep pinned posts", "")}
        ${checkbox("keep_direct", rules.keepDirect, "Keep direct messages", "")}
        ${checkbox("keep_self_fav", rules.keepSelfFavourited, "Keep posts you favourited", "")}
        ${checkbox("keep_self_bookmark", rules.keepSelfBookmarked, "Keep posts you bookmarked", "")}
        ${checkbox("keep_polls", rules.keepPolls, "Keep polls", "")}
        ${checkbox("keep_media", rules.keepMedia, "Keep posts with media attachments", "")}
        <label for="min_favs">Keep posts favourited at least this many times <span class="muted">(leave empty to ignore favourites)</span></label>
        <input id="min_favs" name="min_favs" inputmode="numeric" pattern="[0-9]*" value="${escapeHtml(count(rules.keepFavourites))}" />
        <label for="min_reblogs">Keep posts boosted at least this many times <span class="muted">(leave empty to ignore boosts)</span></label>
        <input id="min_reblogs" name="min_reblogs" inputmode="numeric" pattern="[0-9]*" value="${escapeHtml(count(rules.keepBoosts))}" />
        <button type="submit">Save changes</button>
      </form>
${messageLine(message)}`,
  );
};
