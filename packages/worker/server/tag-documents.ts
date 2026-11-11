import type { ApiFeaturedTagJSON, ApiHashtagJSON, ApiHistoryJSON } from "@tstodon/api";
import { type InstanceIdentity } from "@tstodon/domain";
import { emptyTagHistory, type TagHistoryEntry } from "./tag-store";

/** A tag's page, as Rails' `tag_url`: the name percent-encoded. */
export const tagUrl = (identity: InstanceIdentity, name: string): string =>
  `https://${identity.domain}/tags/${encodeURIComponent(name)}`;

/**
 * Mastodon's Tag. `history` is the last days' uses, newest first; one not
 * read (or empty) renders as days of no uses, as Mastodon always renders the
 * days.
 */
export const mastodonTag = (
  identity: InstanceIdentity,
  name: string,
  options: {
    history?: ReadonlyArray<TagHistoryEntry>;
    following?: boolean;
    featuring?: boolean;
  } = {},
): ApiHashtagJSON => ({
  id: name,
  name,
  url: tagUrl(identity, name),
  history: nonEmptyHistory(options.history ?? []),
  following: options.following ?? false,
  featuring: options.featuring ?? false,
});

const nonEmptyHistory = (
  history: ReadonlyArray<TagHistoryEntry>,
): [ApiHistoryJSON, ...ApiHistoryJSON[]] => {
  const [first, ...rest] = history.length > 0 ? history : emptyTagHistory();
  return first
    ? [{ ...first }, ...rest.map((entry) => ({ ...entry }))]
    : [{ day: "0", uses: "0", accounts: "0" }];
};

/** Mastodon's FeaturedTag: `statuses_count` is a string on the wire. */
export const mastodonFeaturedTag = (
  identity: InstanceIdentity,
  username: string,
  name: string,
  statusesCount: number,
  lastStatusAt: string | null,
): ApiFeaturedTagJSON => ({
  id: name,
  name,
  url: `${identity.publicOrigin.replace(/\/$/, "")}/@${username}/tagged/${encodeURIComponent(name)}`,
  statuses_count: String(statusesCount),
  last_status_at: lastStatusAt,
});
