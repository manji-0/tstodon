import { page } from "./auth-pages";
import { formatCsvRecord, guardCell } from "./csv";
import { escapeHtml } from "./html";
import type {
  AccountSeveranceEvent,
  SeveranceDirection,
  SeveranceType,
  SeveredFollow,
} from "./severed-relationship-store";
import { nav } from "./settings-pages";

/** Mastodon's `/severed_relationships`: the follows moderation decisions removed, and their downloads. */

const EVENT_TYPE_TEXT: Readonly<Record<SeveranceType, (target: string) => string>> = {
  account_suspension: (target) => `Account suspension (${target})`,
  domain_block: (target) => `Server suspension (${target})`,
  user_domain_block: (target) => `You blocked ${target}`,
};

/** The download cell of a count: `None`, or a link whose text is the count. */
const downloadCell = (count: number, href: string): string =>
  count === 0 ? "None" : `<a href="${escapeHtml(href)}" download>Download (${count})</a>`;

const eventRow = (event: AccountSeveranceEvent): string => {
  const base = `/severed_relationships/${encodeURIComponent(event.id)}`;
  return `
        <tr>
          <td><time datetime="${escapeHtml(event.createdAt)}">${escapeHtml(event.createdAt.slice(0, 16).replace("T", " "))} UTC</time></td>
          <td>${escapeHtml(EVENT_TYPE_TEXT[event.type](event.targetName))}</td>${
            event.purged
              ? `
          <td colspan="2">Information about this server has been purged by your server's administrators.</td>`
              : `
          <td>${downloadCell(event.followingCount, `${base}/following.csv`)}</td>
          <td>${downloadCell(event.followersCount, `${base}/followers.csv`)}</td>`
          }
        </tr>`;
};

export const severedRelationshipsPage = (
  instanceName: string,
  events: ReadonlyArray<AccountSeveranceEvent>,
): string =>
  page(
    `Severed relationships · ${instanceName}`,
    `${nav}
      <h1>Severed relationships</h1>
      <p class="muted">You may lose follows and followers when your moderators decide to suspend a remote server or account. When that happens, you can download lists of the severed relationships, to inspect and possibly import on another server.</p>${
        events.length === 0
          ? `
      <p>No relationships have been severed.</p>`
          : `
      <table>
        <thead>
          <tr><th>Date</th><th>Event</th><th>Lost follows</th><th>Lost followers</th></tr>
        </thead>
        <tbody>${events.map(eventRow).join("")}
        </tbody>
      </table>`
      }`,
  );

const FOLLOWING_HEADER = ["Account address", "Show boosts", "Notify on new posts", "Languages"];
const FOLLOWERS_HEADER = ["Account address"];

const flag = (value: boolean): string => (value ? "true" : "false");

/** Mastodon's `following-…csv`: the follows the account lost, with their options. */
export const followingCsv = (follows: ReadonlyArray<SeveredFollow>): string =>
  formatCsvRecord(FOLLOWING_HEADER) +
  follows
    .map((follow) =>
      formatCsvRecord([
        guardCell(follow.acct),
        flag(follow.reblogs),
        flag(follow.notify),
        follow.languages.join(", "),
      ]),
    )
    .join("");

/** Mastodon's `followers-…csv`: the accounts that stopped following. */
export const followersCsv = (follows: ReadonlyArray<SeveredFollow>): string =>
  formatCsvRecord(FOLLOWERS_HEADER) +
  follows.map((follow) => formatCsvRecord([guardCell(follow.acct)])).join("");

/** Mastodon's download name: `following-<target>-<date>.csv`, with only file-name-safe characters. */
export const severedCsvFilename = (
  direction: SeveranceDirection,
  event: AccountSeveranceEvent,
): string =>
  `${direction}-${event.targetName}-${event.createdAt.slice(0, 10)}.csv`.replaceAll(
    /[^A-Za-z0-9._@-]/g,
    "_",
  );
