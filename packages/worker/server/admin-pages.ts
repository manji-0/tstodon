import {
  DELIVERY_FAILURE_DAYS_THRESHOLD,
  type DeliveryDomainHealthValue,
  type RemoteActorModerationValue,
} from "@tstodon/domain";
import type { AdminAccountFilters } from "./account-admin-store";
import type { AdminAccountState } from "./admin-actions";
import type { DomainBlockRow } from "./admin-domain-block-store";
import { page } from "./auth-pages";
import { escapeHtml } from "./html";
import { RemoteAccountId } from "./remote-account-id";
import { checkbox, messageLine, options, type PageMessage } from "./settings-pages";

/**
 * Mastodon's admin pages that its web app links to (`/admin/reports`,
 * `/admin/accounts`, `/admin/instances`, and the content pages in
 * `admin-content-pages.ts`), as plain forms in the style of the settings
 * pages. They act through the same code as `/api/v1/admin`.
 */

/** Where the admin navigation leads, in the order it shows. */
const ADMIN_LINKS = [
  ["/admin/dashboard", "Dashboard"],
  ["/admin/reports", "Reports"],
  ["/admin/accounts", "Accounts"],
  ["/admin/instances", "Federation"],
  ["/admin/announcements", "Announcements"],
  ["/admin/custom_emojis", "Custom emojis"],
  ["/admin/trends/tags", "Trends"],
  ["/admin/email_domain_blocks", "Email domain blocks"],
] as const;

const adminNav = `      <p class="muted"><a href="/">Back to the web app</a> · <a href="/settings/preferences">Preferences</a></p>
      <p><strong>Administration</strong> · ${ADMIN_LINKS.map(([href, label]) => `<a href="${href}">${label}</a>`).join(" · ")}</p>`;

export const adminPage = (instanceName: string, title: string, body: string): string =>
  page(`${title} · ${instanceName}`, `${adminNav}\n${body}`);

/** An account as an admin page names it, linked to its admin page when it has one. */
export type AccountLabel = Readonly<{ label: string; href: string | undefined }>;

export const accountLink = (account: AccountLabel): string =>
  account.href === undefined
    ? escapeHtml(account.label)
    : `<a href="${escapeHtml(account.href)}">${escapeHtml(account.label)}</a>`;

export const postButton = (
  action: string,
  label: string,
  fields: Readonly<Record<string, string>> = {},
): string =>
  `<form method="post" action="${escapeHtml(action)}">${Object.entries(fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`,
    )
    .join("")}<button type="submit">${escapeHtml(label)}</button></form>`;

export const excerpt = (text: string, length = 140): string =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

export const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

export type ReportSummary = Readonly<{
  id: string;
  reporter: AccountLabel;
  target: AccountLabel;
  category: string;
  comment: string;
  statusCount: number;
  assignee: AccountLabel | undefined;
  createdAt: string;
}>;

const reportListItem = (report: ReportSummary): string => `
        <li>
          <a href="/admin/reports/${escapeHtml(report.id)}"><strong>Report #${escapeHtml(report.id)}</strong></a>
          on ${accountLink(report.target)} by ${accountLink(report.reporter)}
          <br /><span class="muted">${escapeHtml(report.category)} · ${count(report.statusCount, "post")} · ${report.assignee === undefined ? "unassigned" : `assigned to ${escapeHtml(report.assignee.label)}`} · ${escapeHtml(report.createdAt)}</span>${
            report.comment.length === 0
              ? ""
              : `
          <br />${escapeHtml(excerpt(report.comment))}`
          }
        </li>`;

/** Mastodon's `GET /admin/reports`: open reports, or resolved ones. */
export const reportsPage = (
  instanceName: string,
  view: Readonly<{
    resolved: boolean;
    reports: ReadonlyArray<ReportSummary>;
    olderHref: string | undefined;
  }>,
  message?: PageMessage,
): string =>
  adminPage(
    instanceName,
    "Reports",
    `      <h1>Reports</h1>
      <p>${
        view.resolved
          ? `<a href="/admin/reports">Unresolved</a> · <strong>Resolved</strong>`
          : `<strong>Unresolved</strong> · <a href="/admin/reports?resolved=1">Resolved</a>`
      }</p>
${messageLine(message)}${
      view.reports.length === 0
        ? `
      <p class="muted">${view.resolved ? "No resolved reports." : "No unresolved reports."}</p>`
        : `
      <ul>${view.reports.map(reportListItem).join("")}
      </ul>`
    }${
      view.olderHref === undefined
        ? ""
        : `
      <p><a href="${escapeHtml(view.olderHref)}">Older reports</a></p>`
    }`,
  );

export type ReportedStatus = Readonly<{ id: string; text: string; createdAt: string }>;

export type ReportDetails = ReportSummary &
  Readonly<{
    statuses: ReadonlyArray<ReportedStatus>;
    rules: ReadonlyArray<string>;
    resolution:
      | Readonly<{ kind: "Open" }>
      | Readonly<{ kind: "Resolved"; at: string; by: AccountLabel }>;
    /**
     * The target's moderation summary and the actions this server can take on
     * it; `undefined` when it cannot act, because the target is gone.
     */
    targetModeration:
      | Readonly<{ summary: string; actions: ReadonlyArray<readonly [string, string]> }>
      | undefined;
    assignedToViewer: boolean;
  }>;

export const moderationSummary = ({ moderation }: AdminAccountState): string => {
  const labels = [
    moderation.standing.kind === "Suspended" ? "suspended" : undefined,
    moderation.standing.kind === "Silenced" ? "limited" : undefined,
    moderation.sensitized ? "media marked sensitive" : undefined,
    moderation.login.kind === "Disabled" ? "login disabled" : undefined,
    moderation.approval.kind === "Pending" ? "waiting for approval" : undefined,
  ].filter((label) => label !== undefined);
  return labels.length === 0 ? "in good standing" : labels.join(", ");
};

/** How a remote actor stands with this server, for the pages that name it. */
export const remoteModerationSummary = (moderation: RemoteActorModerationValue): string => {
  const labels = [
    moderation.standing.kind === "Suspended" ? "suspended" : undefined,
    moderation.standing.kind === "Silenced" ? "limited" : undefined,
    moderation.sensitized ? "media marked sensitive" : undefined,
  ].filter((label) => label !== undefined);
  return labels.length === 0 ? "in good standing" : labels.join(", ");
};

/** The moderation actions a report page offers on a local target. */
export const REPORT_ACTIONS = [
  ["none", "Resolve with no action"],
  ["sensitive", "Mark media as sensitive"],
  ["disable", "Disable login"],
  ["silence", "Limit"],
  ["suspend", "Suspend"],
] as const;

/** A remote actor has no login to disable. */
export const REMOTE_REPORT_ACTIONS = REPORT_ACTIONS.filter(([type]) => type !== "disable");

/** Mastodon's `GET /admin/reports/:id`. */
export const reportPage = (
  instanceName: string,
  report: ReportDetails,
  message?: PageMessage,
): string => {
  const base = `/admin/reports/${report.id}`;
  return adminPage(
    instanceName,
    `Report #${report.id}`,
    `      <h1>Report #${escapeHtml(report.id)}</h1>
${messageLine(message)}
      <ul>
        <li>Reported account: ${accountLink(report.target)}${report.targetModeration === undefined ? "" : ` <span class="muted">(${escapeHtml(report.targetModeration.summary)})</span>`}</li>
        <li>Reported by: ${accountLink(report.reporter)}</li>
        <li>Category: ${escapeHtml(report.category)}</li>
        <li>Filed: ${escapeHtml(report.createdAt)}</li>
        <li>Assigned to: ${report.assignee === undefined ? "nobody" : accountLink(report.assignee)}</li>
        <li>Status: ${
          report.resolution.kind === "Resolved"
            ? `resolved by ${accountLink(report.resolution.by)} at ${escapeHtml(report.resolution.at)}`
            : "unresolved"
        }</li>
      </ul>
      <h2>Comment</h2>
      ${report.comment.length === 0 ? `<p class="muted">No comment.</p>` : `<p>${escapeHtml(report.comment)}</p>`}${
        report.rules.length === 0
          ? ""
          : `
      <h2>Rules broken</h2>
      <ul>${report.rules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join("")}</ul>`
      }
      <h2>Reported posts</h2>${
        report.statuses.length === 0
          ? `
      <p class="muted">${report.statusCount === 0 ? "No posts attached." : "The attached posts are no longer available."}</p>`
          : `
      <ul>${report.statuses
        .map(
          (status) => `
        <li><blockquote>${escapeHtml(status.text)}</blockquote><span class="muted">${escapeHtml(status.createdAt)}</span></li>`,
        )
        .join("")}
      </ul>`
      }
      <h2>Handle this report</h2>
      ${report.assignedToViewer ? postButton(base, "Unassign", { do: "unassign" }) : postButton(base, "Assign to me", { do: "assign_to_self" })}
      ${report.resolution.kind === "Resolved" ? postButton(base, "Reopen", { do: "reopen" }) : postButton(base, "Mark as resolved", { do: "resolve" })}${
        report.targetModeration === undefined
          ? `
      <p class="muted">This server no longer has the reported account, so there is nothing to act on here.</p>`
          : `
      <h2>Act on ${escapeHtml(report.target.label)}</h2>
      <p class="muted">Each action also resolves this report.</p>
      ${report.targetModeration.actions.map(([type, label]) => postButton(`${base}/action`, label, { type })).join("\n      ")}`
      }`,
  );
};

/** Asks again before a destructive form post goes through. */
export const confirmPage = (
  instanceName: string,
  view: Readonly<{
    title: string;
    text: string;
    action: string;
    fields: Readonly<Record<string, string>>;
    confirmLabel: string;
    cancelHref: string;
  }>,
): string =>
  adminPage(
    instanceName,
    view.title,
    `      <h1>${escapeHtml(view.title)}</h1>
      <p>${escapeHtml(view.text)}</p>
      ${postButton(view.action, view.confirmLabel, { ...view.fields, confirmed: "1" })}
      <p><a href="${escapeHtml(view.cancelHref)}">Cancel</a></p>`,
  );

export type AccountsQuery = Readonly<{
  status: AdminAccountFilters["status"];
  username: string;
  email: string;
}>;

/** The account statuses the accounts list filters by, as Mastodon names them. */
const ACCOUNT_STATUSES: ReadonlyArray<readonly [AccountsQuery["status"], string]> = [
  ["active", "Active"],
  ["pending", "Pending"],
  ["silenced", "Limited"],
  ["suspended", "Suspended"],
  ["disabled", "Login disabled"],
  ["sensitized", "Media sensitive"],
];

/** Mastodon's `GET /admin/accounts`. */
export const accountsPage = (
  instanceName: string,
  query: AccountsQuery,
  accounts: ReadonlyArray<AdminAccountState>,
  message?: PageMessage,
): string =>
  adminPage(
    instanceName,
    "Accounts",
    `      <h1>Accounts</h1>
      <form method="get" action="/admin/accounts">
        <label for="status">Status</label>
        <select id="status" name="status">${options(ACCOUNT_STATUSES, query.status)}</select>
        <label for="username">Username</label>
        <input id="username" name="username" value="${escapeHtml(query.username)}" autocomplete="off" />
        <label for="email">Email</label>
        <input id="email" name="email" value="${escapeHtml(query.email)}" autocomplete="off" />
        <button type="submit">Search</button>
      </form>
      <p class="muted">Only accounts on this server are listed. Moderate a remote account's server under Federation.</p>
${messageLine(message)}${
      accounts.length === 0
        ? `
      <p class="muted">No accounts match.</p>`
        : `
      <ul>${accounts
        .map(
          (state) => `
        <li><a href="/admin/accounts/${escapeHtml(state.account.id)}">@${escapeHtml(state.account.username)}</a> <span class="muted">${escapeHtml(state.account.accessEmail.reveal())} · ${escapeHtml(moderationSummary(state))}</span></li>`,
        )
        .join("")}
      </ul>`
    }`,
  );

/** One button on an account's admin page. */
export type AccountActionButton = Readonly<{ command: string; label: string }>;

/** Mastodon's `GET /admin/accounts/:id`. */
export const accountPage = (
  instanceName: string,
  view: Readonly<{
    state: AdminAccountState;
    isViewer: boolean;
    openReports: ReadonlyArray<string>;
    actions: ReadonlyArray<AccountActionButton>;
  }>,
  message?: PageMessage,
): string => {
  const { account } = view.state;
  const action = `/admin/accounts/${account.id}`;
  return adminPage(
    instanceName,
    `@${account.username}`,
    `      <h1>@${escapeHtml(account.username)}</h1>
${messageLine(message)}
      <ul>
        <li>Display name: ${account.displayName.length === 0 ? `<span class="muted">none</span>` : escapeHtml(account.displayName)}</li>
        <li>Email: ${escapeHtml(account.accessEmail.reveal())}</li>
        <li>Joined: ${escapeHtml(account.createdAt)}</li>
        <li>State: ${escapeHtml(moderationSummary(view.state))}</li>
        <li><a href="/@${escapeHtml(account.username)}">Profile in the web app</a></li>
        <li><a href="/admin/accounts/${escapeHtml(account.id)}/statuses">Posts</a></li>
      </ul>
      <h2>Open reports</h2>${
        view.openReports.length === 0
          ? `
      <p class="muted">No open reports.</p>`
          : `
      <ul>${view.openReports.map((id) => `<li><a href="/admin/reports/${escapeHtml(id)}">Report #${escapeHtml(id)}</a></li>`).join("")}</ul>`
      }
      <h2>Moderation</h2>${
        view.isViewer
          ? `
      <p class="muted">You cannot moderate your own account.</p>`
          : `
      ${view.actions.map((button) => postButton(action, button.label, { do: button.command })).join("\n      ")}`
      }`,
  );
};

/** A remote actor's admin page: its standing here and the actions on it. */
export const remoteActorPage = (
  instanceName: string,
  view: Readonly<{
    actorUri: string;
    acct: string;
    domain: string | undefined;
    /** Absent once the actor was purged from this server's cache. */
    moderation: RemoteActorModerationValue | undefined;
    openReports: ReadonlyArray<string>;
    actions: ReadonlyArray<AccountActionButton>;
  }>,
  message?: PageMessage,
): string => {
  const action = `/admin/accounts/${RemoteAccountId.encode(view.actorUri)}`;
  return adminPage(
    instanceName,
    view.acct,
    `      <h1>${escapeHtml(view.acct)}</h1>
${messageLine(message)}
      <ul>
        <li>Actor: <code>${escapeHtml(view.actorUri)}</code></li>
        <li>State: ${view.moderation === undefined ? "no longer known to this server" : escapeHtml(remoteModerationSummary(view.moderation))}</li>
        <li><a href="${escapeHtml(action)}/statuses">Posts</a></li>${
          view.domain === undefined
            ? ""
            : `
        <li><a href="/admin/instances/${escapeHtml(view.domain)}">Moderate ${escapeHtml(view.domain)}</a> as a whole</li>`
        }
      </ul>
      <h2>Open reports</h2>${
        view.openReports.length === 0
          ? `
      <p class="muted">No open reports.</p>`
          : `
      <ul>${view.openReports.map((id) => `<li><a href="/admin/reports/${escapeHtml(id)}">Report #${escapeHtml(id)}</a></li>`).join("")}</ul>`
      }
      <h2>Moderation</h2>${
        view.moderation === undefined
          ? `
      <p class="muted">This server no longer has the account, so there is nothing to act on here.</p>`
          : `
      ${view.actions.map((button) => postButton(action, button.label, { do: button.command })).join("\n      ")}`
      }`,
  );
};

export const adminNotFoundPage = (instanceName: string, what: string): string =>
  adminPage(
    instanceName,
    "Not found",
    `      <h1>Not found</h1>
      <p>There is no such ${escapeHtml(what)}.</p>`,
  );

const SEVERITY_LABELS = { silence: "Limit", suspend: "Suspend", noop: "None" } as const;

const healthLine = (health: DeliveryDomainHealthValue): string =>
  health.kind === "Unavailable"
    ? `Unavailable since ${escapeHtml(health.unavailableSince.slice(0, 10))}: deliveries are skipped (failures on ${health.failureDays} days, last ${escapeHtml(health.lastFailureDay)})`
    : `Failing: deliveries failed on ${health.failureDays} of ${DELIVERY_FAILURE_DAYS_THRESHOLD} days before it is marked unavailable (last ${escapeHtml(health.lastFailureDay)})`;

/**
 * Mastodon's `GET /admin/instances`: the domains this server blocks, and the
 * ones deliveries fail to (Mastodon's "Unavailable" filter).
 */
export const instancesPage = (
  instanceName: string,
  blocks: ReadonlyArray<DomainBlockRow>,
  message?: PageMessage,
  health: ReadonlyArray<DeliveryDomainHealthValue> = [],
): string =>
  adminPage(
    instanceName,
    "Federation",
    `      <h1>Federation</h1>
      <form method="get" action="/admin/instances">
        <label for="domain">Domain</label>
        <input id="domain" name="domain" required placeholder="example.com" autocomplete="off" />
        <button type="submit">Moderate domain</button>
      </form>
${messageLine(message)}
      <h2>Blocked domains</h2>${
        blocks.length === 0
          ? `
      <p class="muted">No domains are blocked.</p>`
          : `
      <ul>${blocks
        .map(
          (block) => `
        <li><a href="/admin/instances/${escapeHtml(block.domain)}">${escapeHtml(block.domain)}</a> <span class="muted">${SEVERITY_LABELS[block.severity]}${block.reject_media === 0 ? "" : " · rejects media"}${block.reject_reports === 0 ? "" : " · rejects reports"}</span></li>`,
        )
        .join("")}
      </ul>`
      }
      <h2>Delivery failures</h2>${
        health.length === 0
          ? `
      <p class="muted">Deliveries are not failing to any domain.</p>`
          : `
      <ul>${health
        .map(
          (entry) => `
        <li><a href="/admin/instances/${escapeHtml(entry.domain)}">${escapeHtml(entry.domain)}</a> <span class="muted">${healthLine(entry)}</span></li>`,
        )
        .join("")}
      </ul>`
      }`,
  );

export type DomainBlockForm = Readonly<{
  severity: DomainBlockRow["severity"];
  rejectMedia: boolean;
  rejectReports: boolean;
  obfuscate: boolean;
  privateComment: string;
  publicComment: string;
}>;

/** Mastodon's `GET /admin/instances/:domain`, with the form that blocks it. */
export const instancePage = (
  instanceName: string,
  view: Readonly<{
    domain: string;
    blocked: boolean;
    form: DomainBlockForm;
    health?: DeliveryDomainHealthValue | undefined;
  }>,
  message?: PageMessage,
): string => {
  const action = `/admin/instances/${view.domain}`;
  return adminPage(
    instanceName,
    view.domain,
    `      <h1>${escapeHtml(view.domain)}</h1>
${messageLine(message)}
      <p>${
        view.blocked
          ? `This server blocks <strong>${escapeHtml(view.domain)}</strong>: ${escapeHtml(SEVERITY_LABELS[view.form.severity].toLowerCase())}.`
          : `This server does not block <strong>${escapeHtml(view.domain)}</strong>.`
      }</p>
      <h2>${view.blocked ? "Change the block" : "Block this domain"}</h2>
      <form method="post" action="${escapeHtml(action)}">
        <input type="hidden" name="do" value="save" />
        <label for="severity">Severity</label>
        <select id="severity" name="severity">${options(
          [
            ["silence", "Limit: hide its accounts from people who do not follow them"],
            ["suspend", "Suspend: refuse all its content and remove its accounts' data"],
            ["noop", "None: only reject media or reports"],
          ],
          view.form.severity,
        )}</select>
        ${checkbox("reject_media", view.form.rejectMedia, "Reject media files", "Its attachments are not stored.")}
        ${checkbox("reject_reports", view.form.rejectReports, "Reject reports", "Reports from this server are ignored.")}
        ${checkbox("obfuscate", view.form.obfuscate, "Obfuscate domain name", "The public list of blocks shows it partly hidden.")}
        <label for="public_comment">Public comment</label>
        <input id="public_comment" name="public_comment" value="${escapeHtml(view.form.publicComment)}" />
        <label for="private_comment">Private comment</label>
        <input id="private_comment" name="private_comment" value="${escapeHtml(view.form.privateComment)}" />
        <button type="submit">${view.blocked ? "Save changes" : "Block domain"}</button>
      </form>${
        view.blocked
          ? `
      <h2>Lift the block</h2>
      ${postButton(action, "Remove block", { do: "remove" })}`
          : ""
      }
      <h2>Delivery</h2>${
        view.health === undefined
          ? `
      <p class="muted">No delivery failures are recorded for this domain.</p>`
          : `
      <p>${healthLine(view.health)}.</p>
      ${postButton(action, "Mark as available", { do: "mark_available" })}`
      }`,
  );
};
