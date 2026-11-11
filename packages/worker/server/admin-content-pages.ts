import type { AdminDashboard } from "./admin-dashboard-store";
import type { AdminStatusEntry } from "./admin-status-actions";
import {
  type AccountLabel,
  accountLink,
  adminPage,
  count,
  excerpt,
  postButton,
} from "./admin-pages";
import { escapeHtml } from "./html";
import { checkbox, messageLine, type PageMessage } from "./settings-pages";

/**
 * Mastodon's admin pages for what the server says and shows (`/admin/dashboard`,
 * `/admin/announcements`, `/admin/custom_emojis`, `/admin/trends/*`,
 * `/admin/email_domain_blocks`) and for one account's posts, as plain forms
 * in the style of the other admin pages.
 */

const list = (items: ReadonlyArray<string>): string =>
  `
      <ul>${items.join("")}
      </ul>`;

/** Mastodon's `GET /admin/dashboard`. */
export const dashboardPage = (instanceName: string, stats: AdminDashboard): string =>
  adminPage(
    instanceName,
    "Dashboard",
    "/admin/dashboard",
    `      <h1>Dashboard</h1>
      <ul>
        <li><a href="/admin/reports">Open reports</a>: <strong>${stats.openReports}</strong></li>
        <li><a href="/admin/accounts?status=pending">Accounts waiting for approval</a>: <strong>${stats.pendingApprovals}</strong></li>
        <li>New sign-ups in the last 7 days: <strong>${stats.signUpsLastWeek}</strong></li>
        <li>Active users in the last 7 days: <strong>${stats.activeUsersLastWeek}</strong></li>
      </ul>
      <p class="muted">An active user has a refreshed browser session, a new access token, or a new post in that week. The server keeps no other sign-in time.</p>`,
  );

export type AccountStatusesView = Readonly<{
  account: AccountLabel;
  /** The account's page, where its other admin pages hang. */
  accountPath: string;
  statuses: ReadonlyArray<AdminStatusEntry>;
  olderHref: string | undefined;
}>;

const statusItem = (status: AdminStatusEntry): string => `
        <li>
          <label><input type="checkbox" name="status_ids" value="${escapeHtml(status.id)}" />
          ${status.spoilerText.length === 0 ? "" : `<strong>${escapeHtml(excerpt(status.spoilerText, 60))}</strong> `}${escapeHtml(excerpt(status.text))}</label>
          <br /><span class="muted">${escapeHtml(status.visibility)}${status.sensitive ? " · sensitive" : ""} · ${escapeHtml(status.createdAt)}</span>
        </li>`;

/** Mastodon's `GET /admin/accounts/:id/statuses`: pick posts, then mark them sensitive or delete them. */
export const accountStatusesPage = (
  instanceName: string,
  view: AccountStatusesView,
  message?: PageMessage,
): string =>
  adminPage(
    instanceName,
    `Posts of ${view.account.label}`,
    "/admin/accounts",
    `      <h1>Posts of ${accountLink(view.account)}</h1>
${messageLine(message)}${
      view.statuses.length === 0
        ? `
      <p class="muted">No posts.</p>`
        : `
      <form method="post" action="${escapeHtml(view.accountPath)}/statuses">
      <ul>${view.statuses.map(statusItem).join("")}
      </ul>
        <button type="submit" name="do" value="sensitize">Mark as sensitive</button>
        <button type="submit" name="do" value="unsensitize">Mark as not sensitive</button>
        <button type="submit" name="do" value="delete">Delete</button>
      </form>`
    }${
      view.olderHref === undefined
        ? ""
        : `
      <p><a href="${escapeHtml(view.olderHref)}">Older posts</a></p>`
    }`,
  );

/** An announcement as the list shows it. */
export type AnnouncementEntry = Readonly<{
  id: string;
  /** Plain text of its content. */
  text: string;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  publishedAt: string | null;
}>;

/** An announcement's fields as its form holds them, `datetime-local` values for the times. */
export type AnnouncementForm = Readonly<{
  text: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
}>;

const announcementFields = (form: AnnouncementForm): string => `
        <label for="text">Text</label>
        <textarea id="text" name="text" rows="4" required>${escapeHtml(form.text)}</textarea>
        <label for="starts_at">Starts at</label>
        <input id="starts_at" name="starts_at" type="datetime-local" value="${escapeHtml(form.startsAt)}" />
        <label for="ends_at">Ends at</label>
        <input id="ends_at" name="ends_at" type="datetime-local" value="${escapeHtml(form.endsAt)}" />
        ${checkbox("all_day", form.allDay, "All day", "The times show as dates.")}`;

const announcementItem = (entry: AnnouncementEntry): string => `
        <li>
          <a href="/admin/announcements/${escapeHtml(entry.id)}">${escapeHtml(excerpt(entry.text))}</a>
          <br /><span class="muted">${entry.publishedAt === null ? "draft" : `published ${escapeHtml(entry.publishedAt)}`}${entry.startsAt === null ? "" : ` · starts ${escapeHtml(entry.startsAt)}`}${entry.endsAt === null ? "" : ` · ends ${escapeHtml(entry.endsAt)}`}</span>
        </li>`;

/** Mastodon's `GET /admin/announcements`, with the form that adds one. */
export const announcementsPage = (
  instanceName: string,
  view: Readonly<{ announcements: ReadonlyArray<AnnouncementEntry>; form: AnnouncementForm }>,
  message?: PageMessage,
): string =>
  adminPage(
    instanceName,
    "Announcements",
    "/admin/announcements",
    `      <h1>Announcements</h1>
${messageLine(message)}${
      view.announcements.length === 0
        ? `
      <p class="muted">No announcements.</p>`
        : list(view.announcements.map(announcementItem))
    }
      <h2>New announcement</h2>
      <form method="post" action="/admin/announcements">${announcementFields(view.form)}
        ${checkbox("publish", true, "Publish now", "Leave it off to keep a draft.")}
        <button type="submit">Create announcement</button>
      </form>`,
  );

/** Mastodon's `GET /admin/announcements/:id/edit`. */
export const announcementPage = (
  instanceName: string,
  view: Readonly<{ entry: AnnouncementEntry; form: AnnouncementForm }>,
  message?: PageMessage,
): string => {
  const action = `/admin/announcements/${view.entry.id}`;
  return adminPage(
    instanceName,
    "Announcement",
    "/admin/announcements",
    `      <h1>Announcement</h1>
${messageLine(message)}
      <p>${view.entry.publishedAt === null ? "This announcement is a draft." : `Published ${escapeHtml(view.entry.publishedAt)}.`}</p>
      <form method="post" action="${escapeHtml(action)}">
        <input type="hidden" name="do" value="save" />${announcementFields(view.form)}
        <button type="submit">Save changes</button>
      </form>
      ${view.entry.publishedAt === null ? postButton(action, "Publish", { do: "publish" }) : postButton(action, "Unpublish", { do: "unpublish" })}
      ${postButton(action, "Delete", { do: "delete" }, "danger")}
      <p><a href="/admin/announcements">Back to announcements</a></p>`,
  );
};

/** A custom emoji as the list shows it. */
export type EmojiEntry = Readonly<{
  id: string;
  shortcode: string;
  url: string;
  category: string | null;
  visibleInPicker: boolean;
}>;

export type EmojiForm = Readonly<{ shortcode: string; category: string; visibleInPicker: boolean }>;

const emojiItem = (emoji: EmojiEntry): string => `
        <li>
          <img src="${escapeHtml(emoji.url)}" alt=":${escapeHtml(emoji.shortcode)}:" width="24" height="24" />
          <strong>:${escapeHtml(emoji.shortcode)}:</strong>
          <span class="muted">${emoji.category === null ? "no category" : escapeHtml(emoji.category)} · ${emoji.visibleInPicker ? "shown in the picker" : "hidden from the picker"}</span>
          ${postButton("/admin/custom_emojis", emoji.visibleInPicker ? "Hide from the picker" : "Show in the picker", { do: emoji.visibleInPicker ? "hide" : "show", id: emoji.id })}
          ${postButton("/admin/custom_emojis", "Delete", { do: "delete", id: emoji.id }, "danger")}
        </li>`;

/** Mastodon's `GET /admin/custom_emojis`, with the form that uploads one. */
export const emojisPage = (
  instanceName: string,
  view: Readonly<{ emojis: ReadonlyArray<EmojiEntry>; form: EmojiForm }>,
  message?: PageMessage,
): string =>
  adminPage(
    instanceName,
    "Custom emojis",
    "/admin/custom_emojis",
    `      <h1>Custom emojis</h1>
${messageLine(message)}${
      view.emojis.length === 0
        ? `
      <p class="muted">No custom emojis.</p>`
        : list(view.emojis.map(emojiItem))
    }
      <h2>Upload an emoji</h2>
      <form method="post" action="/admin/custom_emojis" enctype="multipart/form-data">
        <input type="hidden" name="do" value="upload" />
        <label for="shortcode">Shortcode</label>
        <input id="shortcode" name="shortcode" value="${escapeHtml(view.form.shortcode)}" required autocomplete="off" />
        <label for="category">Category</label>
        <input id="category" name="category" value="${escapeHtml(view.form.category)}" autocomplete="off" />
        <label for="image">Image</label>
        <input id="image" name="image" type="file" accept="image/*" required />
        ${checkbox("visible_in_picker", view.form.visibleInPicker, "Show in the picker", "People can choose it when they write a post.")}
        <button type="submit">Upload emoji</button>
      </form>`,
  );

/** The three kinds of trend a moderator reviews, as their pages name them. */
export const TREND_FAMILIES = [
  ["tags", "Hashtags"],
  ["links", "Links"],
  ["statuses", "Posts"],
] as const;

export type TrendFamily = (typeof TREND_FAMILIES)[number][0];

/** A trend as its page shows it. */
export type TrendEntry = Readonly<{
  /** What a review post names: the tag, the link's URL, or the post's id. */
  target: string;
  label: string;
  /** Where the trend itself lives, when it has a page. */
  href: string | undefined;
  detail: string;
  /** The moderator's decision, if any. */
  review: "Approved" | "Rejected" | undefined;
}>;

const trendItem = (family: TrendFamily, entry: TrendEntry): string => {
  const action = `/admin/trends/${family}`;
  return `
        <li>
          ${entry.href === undefined ? escapeHtml(entry.label) : `<a href="${escapeHtml(entry.href)}">${escapeHtml(entry.label)}</a>`}
          <br /><span class="muted">${escapeHtml(entry.detail)} · ${entry.review === undefined ? "waiting for review" : entry.review.toLowerCase()}</span>
          ${postButton(action, "Approve", { do: "approve", target: entry.target })}
          ${postButton(action, "Reject", { do: "reject", target: entry.target })}
        </li>`;
};

/** Mastodon's `GET /admin/trends/tags`, `/links`, and `/statuses`. */
export const trendsPage = (
  instanceName: string,
  view: Readonly<{ family: TrendFamily; entries: ReadonlyArray<TrendEntry> }>,
  message?: PageMessage,
): string =>
  adminPage(
    instanceName,
    "Trends",
    "/admin/trends/tags",
    `      <h1>Trends</h1>
      <p>${TREND_FAMILIES.map(([family, label]) => (family === view.family ? `<strong>${label}</strong>` : `<a href="/admin/trends/${family}">${label}</a>`)).join(" · ")}</p>
${messageLine(message)}${
      view.entries.length === 0
        ? `
      <p class="muted">Nothing is trending.</p>`
        : list(view.entries.map((entry) => trendItem(view.family, entry)))
    }`,
  );

/** An email domain block as the list shows it. */
export type EmailDomainBlockEntry = Readonly<{
  id: string;
  domain: string;
  createdAt: string;
  /** Accounts created with an address on the domain in the last 5 days. */
  recentAccounts: number;
}>;

/** Mastodon's `GET /admin/email_domain_blocks`, with the form that adds one. */
export const emailDomainBlocksPage = (
  instanceName: string,
  view: Readonly<{ blocks: ReadonlyArray<EmailDomainBlockEntry>; domain: string }>,
  message?: PageMessage,
): string =>
  adminPage(
    instanceName,
    "Email domain blocks",
    "/admin/email_domain_blocks",
    `      <h1>Email domain blocks</h1>
      <p class="muted">Nobody can sign up with an email address on a blocked domain.</p>
${messageLine(message)}${
      view.blocks.length === 0
        ? `
      <p class="muted">No email domains are blocked.</p>`
        : list(
            view.blocks.map(
              (block) => `
        <li>
          <strong>${escapeHtml(block.domain)}</strong>
          <span class="muted">${escapeHtml(block.createdAt)} · ${count(block.recentAccounts, "account")} created in the last 5 days</span>
          ${postButton("/admin/email_domain_blocks", "Remove block", { do: "remove", id: block.id }, "danger")}
        </li>`,
            ),
          )
    }
      <h2>Block an email domain</h2>
      <form method="post" action="/admin/email_domain_blocks">
        <input type="hidden" name="do" value="add" />
        <label for="domain">Domain</label>
        <input id="domain" name="domain" value="${escapeHtml(view.domain)}" required placeholder="example.com" autocomplete="off" />
        <button type="submit">Block domain</button>
      </form>`,
  );
