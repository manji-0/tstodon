import { SUPPRESSED_ACCOUNT_IDS_SQL, SUPPRESSED_ACTOR_URIS_SQL } from "./block-mute-store";
import { DOMAIN_RESTRICTED_ACTORS_SQL, DOMAIN_SUSPENDED_ACTORS_SQL } from "./domain-hidden-actors";
import { type IdCursor, idCursorBounds } from "./id-cursor";
import { ENTITY_ID_DIGITS } from "./ids";
import type { ListRepliesPolicy } from "./list-store";

/**
 * A timeline fed by the viewer's accepted follows of remote actors: home, or
 * one of the viewer's lists, which holds the followed actors put on it.
 */
export type FollowedFeed = Readonly<{ kind: "Home" }> | ListFeed;

export type ListFeed = Readonly<{
  kind: "List";
  listId: string;
  repliesPolicy: ListRepliesPolicy;
}>;

type SqlFragment = Readonly<{ sql: string; binds: string[] }>;

/**
 * Leaves out the local `statuses` rows of suspended authors before a feed's
 * `LIMIT`, as Mastodon unmerges a suspended account's statuses and boosts
 * from its followers' feeds. Others' boosts of them stay.
 */
export const FEED_SUSPENDED_AUTHORS_SQL = `AND account_id NOT IN (
  SELECT account_id FROM account_moderation WHERE moderation = 'Suspended'
)`;

/**
 * Local accounts on one of the viewer's exclusive lists, which Mastodon keeps
 * off the viewer's home. Takes the viewer id once.
 */
export const EXCLUSIVE_LIST_MEMBER_ACCOUNTS_SQL = `(
  SELECT m.member_account_id FROM account_list_members m
  JOIN account_lists l ON l.id = m.list_id
  WHERE l.account_id = ? AND l.exclusive <> 0
)`;

/**
 * Holds when the local boost (a `LocalReblog` row of `statuses`) boosts an
 * author the viewer sees: not a local one it blocks, is blocked by or mutes,
 * nor a remote one it blocks, is blocked by or mutes, on a domain it blocks or
 * the instance suspends.
 */
export const reblogOfShownAuthorSql = (viewerId: string, now: string): SqlFragment => {
  const remoteAuthor =
    "COALESCE((SELECT r.actor_uri FROM remote_statuses r WHERE r.id = statuses.reblog_of_remote_id), '')";
  return {
    sql: `COALESCE((SELECT t.account_id FROM statuses t WHERE t.id = statuses.reblog_of_id), '')
          NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL}
        AND ${remoteAuthor} NOT IN ${SUPPRESSED_ACTOR_URIS_SQL}
        AND ${remoteAuthor} NOT IN ${DOMAIN_SUSPENDED_ACTORS_SQL}`,
    binds: [viewerId, viewerId, viewerId, now, viewerId, viewerId, viewerId, now, viewerId],
  };
};

/** The local accounts the viewer blocks or mutes. Takes the viewer twice and the clock. */
const BLOCKED_OR_MUTED_ACCOUNTS_SQL = `(
  SELECT target_account_id FROM blocks WHERE blocker_account_id = ? AND target_account_id IS NOT NULL
  UNION ALL
  SELECT target_account_id FROM mutes
    WHERE account_id = ? AND target_account_id IS NOT NULL AND (expires_at IS NULL OR expires_at > ?)
)`;

/** The actors the viewer blocks or mutes. Takes the viewer twice and the clock. */
const BLOCKED_OR_MUTED_ACTORS_SQL = `(
  SELECT target_actor_uri FROM blocks WHERE blocker_account_id = ?
  UNION ALL
  SELECT target_actor_uri FROM mutes WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?)
)`;

/**
 * Holds when a status actively mentions an account or actor the viewer
 * blocks or mutes (a mute that keeps notifications too), as Mastodon's
 * `FeedManager` checks `crutches[:active_mentions]` against `blocking` and
 * `muting`. `local` and `remote` are expressions yielding the id of a local
 * `statuses` row and of a `remote_statuses` row; either may yield NULL. Each
 * test seeks the status's mentions by its id and checks them against the
 * viewer's blocks and mutes, gathered once: the unary `+` keeps SQLite from
 * seeking the mention table once per block or mute instead.
 */
export const mentionsBlockedOrMutedSql = (
  viewerId: string,
  now: string,
  status: Readonly<{ local?: string; remote?: string }>,
): SqlFragment => {
  const binds = [viewerId, viewerId, now];
  const probe = (table: string, id: string, target: string): SqlFragment => ({
    sql: `EXISTS (SELECT 1 FROM ${table} m WHERE m.status_id = ${id} AND ${target})`,
    binds,
  });
  const accounts = `+m.account_id IN ${BLOCKED_OR_MUTED_ACCOUNTS_SQL}`;
  const actors = `+m.actor_uri IN ${BLOCKED_OR_MUTED_ACTORS_SQL}`;
  const probes = [
    ...(status.local === undefined
      ? []
      : [
          probe("status_mentions", status.local, accounts),
          probe("status_remote_mentions", status.local, actors),
        ]),
    ...(status.remote === undefined
      ? []
      : [
          // A silent mention is not an active one (`Mention.active`).
          probe("remote_status_mentions", status.remote, `m.silent = 0 AND ${accounts}`),
          probe("remote_status_remote_mentions", status.remote, actors),
        ]),
  ];
  return {
    sql: `(${probes.map((part) => part.sql).join(" OR ")})`,
    binds: probes.flatMap((part) => part.binds),
  };
};

/**
 * Leaves out of a feed the local `statuses` rows that mention an account the
 * viewer blocks or mutes ({@link mentionsBlockedOrMutedSql}), except the
 * viewer's own, which Mastodon's `filter_from_home` keeps whatever they hold.
 */
export const feedLocalMentionsSql = (viewerId: string, now: string): SqlFragment => {
  const hidden = mentionsBlockedOrMutedSql(viewerId, now, { local: "statuses.id" });
  return {
    sql: `AND (statuses.account_id = ? OR NOT ${hidden.sql})`,
    binds: [viewerId, ...hidden.binds],
  };
};

/**
 * The local boosts (`LocalReblog` rows of `statuses`) a feed of the viewer
 * keeps, by Mastodon's `FeedManager`: the viewer's own always; another's
 * unless the viewer's follow of the booster hides its reblogs, the viewer
 * does not see the boosted status's author ({@link reblogOfShownAuthorSql}),
 * or the boosted status mentions an account the viewer blocks or mutes.
 * Notes pass.
 */
export const feedLocalReblogsSql = (viewerId: string, now: string): SqlFragment => {
  const shown = reblogOfShownAuthorSql(viewerId, now);
  const mentions = mentionsBlockedOrMutedSql(viewerId, now, {
    local: "statuses.reblog_of_id",
    remote: "statuses.reblog_of_remote_id",
  });
  return {
    sql: `AND (
      statuses.kind <> 'LocalReblog' OR statuses.account_id = ? OR (
        statuses.account_id NOT IN (
          SELECT target_account_id FROM follows
          WHERE follower_account_id = ? AND kind = 'Accepted' AND reblogs = 0
        )
        AND ${shown.sql}
        AND NOT ${mentions.sql}
      )
    )`,
    binds: [viewerId, viewerId, ...shown.binds, ...mentions.binds],
  };
};

/**
 * The followed hashtags a home page reads, the most recently followed first.
 * Mastodon reads none at all on a home page: it delivers each post to its
 * hashtags' followers once (`FanOutOnWriteService#deliver_to_hashtag_followers`)
 * and keeps 800 home entries. Here a page reads at most this many hashtags,
 * each to a {@link HOME_FOLLOWED_TAG_DEPTH bounded depth}, so its rows read
 * do not grow with how many posts carry those hashtags.
 */
export const HOME_FOLLOWED_TAG_LIMIT = 25;

/**
 * Where a side of home finds the notes under a hashtag: its tag index, its
 * notes table, and which of those notes a followed hashtag brings. The unary
 * `+` keeps SQLite on the tag index and the notes' primary key.
 */
const FOLLOWED_TAG_SIDES = {
  Local: {
    tags: "local_status_tags",
    notes: "statuses",
    shown: "+n.kind = 'LocalNote' AND +n.visibility = 'public' AND n.account_id NOT IN hidden",
    /**
     * The authors home leaves out ({@link SUPPRESSED_ACCOUNT_IDS_SQL}) and
     * those the instance limits. Members of the viewer's exclusive lists
     * stay, as `filter_from_tags?` does not read those lists.
     */
    hidden: (viewerId: string, now: string): SqlFragment => ({
      sql: `SELECT * FROM ${SUPPRESSED_ACCOUNT_IDS_SQL}
        UNION SELECT account_id FROM account_moderation WHERE moderation IN ('Silenced', 'Suspended')`,
      binds: [viewerId, viewerId, viewerId, now],
    }),
  },
  Remote: {
    tags: "remote_status_tags",
    notes: "remote_statuses",
    shown: "+n.visibility = 'public' AND n.actor_uri NOT IN hidden",
    /**
     * The actors the viewer blocks or mutes or that block it, and those on a
     * domain it blocks or the instance limits. Followed actors stay: the
     * hashtag brings their notes the followed-actor query leaves out (an
     * exclusive list's, a reply to a stranger's, another language's), and
     * home drops the notes both queries list once.
     */
    hidden: (viewerId: string, now: string): SqlFragment => ({
      sql: `SELECT * FROM ${SUPPRESSED_ACTOR_URIS_SQL}
        UNION SELECT * FROM ${DOMAIN_RESTRICTED_ACTORS_SQL}`,
      binds: [viewerId, viewerId, viewerId, now, viewerId],
    }),
  },
} as const;

/**
 * How deep a home page reads each followed hashtag's index below its cursor,
 * as a multiple of the page's size. Past that the page stops at the
 * {@link followedTagHorizonSql horizon}.
 */
export const HOME_FOLLOWED_TAG_DEPTH = 4;

/** The viewer's most recently followed hashtags, with the id floor of each follow. */
const followedTagsCte = `ft AS (
  SELECT tag_name,
    printf('%0${ENTITY_ID_DIGITS}d',
      CAST(round((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER) << 16) AS floor
  FROM followed_tags WHERE account_id = ?
  ORDER BY created_at DESC, tag_name LIMIT ${HOME_FOLLOWED_TAG_LIMIT}
)`;

/**
 * The bounds on a tag index row `t` of followed hashtag `ft`: its id floor,
 * the cursor's bound (the CTE `c(v)`) and, when `horizon` is given, the
 * horizon (the CTE `w(h)`). Every lower bound is folded into one `max(...)`,
 * so SQLite starts the index range at the highest of them.
 */
const tagIndexBounds = (
  cursor: IdCursor,
  horizon: boolean,
): Readonly<{ bound: string; sql: string }> => {
  const { onlyId, after, before, ascending } = idCursorBounds(cursor);
  if (onlyId.length > 0) {
    return { bound: onlyId, sql: "t.status_id = (SELECT v FROM c) AND t.status_id >= ft.floor" };
  }
  const lower = [
    "ft.floor",
    ...(after.length > 0 ? ["(SELECT v FROM c)"] : []),
    ...(horizon && !ascending ? ["(SELECT h FROM w)"] : []),
  ];
  return {
    bound: after.length > 0 ? after : before,
    sql: [
      `t.status_id >= ${lower.length > 1 ? `max(${lower.join(", ")})` : lower[0]}`,
      ...(after.length > 0 ? ["t.status_id <> (SELECT v FROM c)"] : []),
      ...(before.length > 0 ? ["t.status_id < (SELECT v FROM c)"] : []),
      ...(horizon && ascending ? ["t.status_id <= (SELECT h FROM w)"] : []),
    ].join(" AND "),
  };
};

/**
 * How far a home page can vouch for the notes under the viewer's followed
 * hashtags: for each hashtag whose index holds more than
 * {@link HOME_FOLLOWED_TAG_DEPTH} pages below the cursor (above it for a
 * `min_id` page), the id that deep, local and remote; the newest of those
 * (the oldest for `min_id`), or NULL when every hashtag is read to its end.
 * Reads only the tag indexes, a fixed depth per hashtag. One row,
 * `horizon`.
 */
export const followedTagHorizonSql = (
  viewerId: string,
  cursor: IdCursor,
  limit: number,
): SqlFragment => {
  const { bound, sql: within } = tagIndexBounds(cursor, false);
  const { ascending } = idCursorBounds(cursor);
  const deep = Math.max(1, Math.trunc(limit) * HOME_FOLLOWED_TAG_DEPTH) - 1;
  const edge = (tags: string): string => `SELECT (
      SELECT t.status_id FROM ${tags} t
      WHERE t.tag = ft.tag_name AND ${within}
      ORDER BY t.status_id ${ascending ? "ASC" : "DESC"} LIMIT 1 OFFSET ${deep}
    ) AS id FROM ft`;
  return {
    sql: `WITH ${followedTagsCte}, c(v) AS (SELECT ?)
      SELECT ${ascending ? "MIN" : "MAX"}(id) AS horizon FROM (
        ${edge("local_status_tags")} UNION ALL ${edge("remote_status_tags")}
      )`,
    binds: [viewerId, bound],
  };
};

/**
 * The ids of the notes a followed hashtag brings to the viewer's home page,
 * as Mastodon's `deliver_to_hashtag_followers`: public notes (not of a
 * silenced or suspended local author), posted or received since the viewer
 * followed the hashtag, of the viewer's {@link HOME_FOLLOWED_TAG_LIMIT} most
 * recently followed hashtags. An id sorts by the instant it was made at, so
 * "since the follow" is an id floor: the follow's instant shifted above the
 * id's low 16 bits (`entityIdAt`). The side's `hidden` authors are left out.
 * The ids lie within `cursor` and, when the page has a `horizon`
 * ({@link followedTagHorizonSql}), not past it, so a page reads a bounded
 * depth of each hashtag's index however many notes it holds or hides. The
 * binds are the viewer's, the cursor's and the horizon, however many
 * hashtags.
 */
export const followedTagNoteIdsSql = (
  side: keyof typeof FOLLOWED_TAG_SIDES,
  viewerId: string,
  now: string,
  cursor: IdCursor,
  horizon: string | undefined,
): SqlFragment => {
  const { tags, notes, shown } = FOLLOWED_TAG_SIDES[side];
  const hidden = FOLLOWED_TAG_SIDES[side].hidden(viewerId, now);
  const { bound, sql: within } = tagIndexBounds(cursor, horizon !== undefined);
  return {
    sql: `(
      WITH ${followedTagsCte}, c(v) AS (SELECT ?), w(h) AS (SELECT ?),
      hidden(id) AS MATERIALIZED (
        ${hidden.sql}
      )
      SELECT DISTINCT t.status_id FROM ft
      CROSS JOIN ${tags} t
      CROSS JOIN ${notes} n ON n.id = t.status_id
      WHERE t.tag = ft.tag_name AND ${within} AND ${shown}
    )`,
    binds: [viewerId, bound, horizon ?? "", ...hidden.binds],
  };
};

/**
 * Keep the home entries a page with this `horizon` can vouch for: none past
 * it, as the notes of the followed hashtags past it were not read.
 */
export const withinHorizon = <T extends Readonly<{ id: string }>>(
  entries: ReadonlyArray<T>,
  cursor: IdCursor,
  horizon: string | undefined,
): T[] =>
  horizon === undefined
    ? [...entries]
    : entries.filter((entry) =>
        idCursorBounds(cursor).ascending ? entry.id <= horizon : entry.id >= horizon,
      );

/**
 * The local `statuses` rows a feed of the viewer keeps by the viewer's follow
 * of their author: a follow with `languages[]` keeps statuses in those
 * languages and ones without a language, as Mastodon's `FeedManager` does on
 * home and lists. Takes the viewer id once.
 */
export const FEED_LANGUAGES_SQL = `AND NOT EXISTS (
  SELECT 1 FROM follows f
  WHERE f.follower_account_id = ? AND f.kind = 'Accepted'
    AND f.target_account_id = statuses.account_id
    AND f.languages_json <> '[]'
    AND COALESCE(statuses.language, '') <> ''
    AND statuses.language NOT IN (SELECT value FROM json_each(f.languages_json))
)`;

/**
 * Narrows the follow `f` to the feed's follows: a list's members, and for
 * home all but those on one of the viewer's exclusive lists.
 */
export const feedFollowSql = (feed: FollowedFeed): SqlFragment => {
  switch (feed.kind) {
    case "Home":
      return {
        sql: `AND f.id NOT IN (
          SELECT m.outbound_follow_id FROM account_list_remote_members m
          JOIN account_lists l ON l.id = m.list_id
          WHERE l.exclusive <> 0 AND l.account_id = f.account_id
        )`,
        binds: [],
      };
    case "List":
      return {
        sql: "AND f.id IN (SELECT outbound_follow_id FROM account_list_remote_members WHERE list_id = ?)",
        binds: [feed.listId],
      };
  }
};

/**
 * How one side of a feed (local `statuses` or remote `s`) reads whom a reply
 * answers, as stored when it was linked (Mastodon's
 * `in_reply_to_account_id`): `account` and `actor` are its local account id
 * and remote actor URI columns, at most one set; `self` holds when the reply
 * answers its own author.
 */
type ReplyParent = Readonly<{
  isReply: string;
  account: string;
  actor: string;
  self: string;
}>;

const FOLLOWED_ACCOUNTS_SQL = `(SELECT target_account_id FROM follows WHERE follower_account_id = ? AND kind = 'Accepted')`;
const FOLLOWED_ACTORS_SQL = `(SELECT actor_uri FROM outbound_follows WHERE account_id = ? AND state = 'Accepted')`;
const LIST_ACCOUNTS_SQL = `(SELECT member_account_id FROM account_list_members WHERE list_id = ?)`;
const LIST_ACTORS_SQL = `(SELECT f.actor_uri FROM outbound_follows f
  JOIN account_list_remote_members m ON m.outbound_follow_id = f.id
  WHERE m.list_id = ? AND f.state = 'Accepted')`;

/** Whose replies a feed keeps; home's are the ones a list with `followed` keeps. */
type RepliesFeed = Readonly<{ kind: "Home" }> | ListFeed;

/**
 * The replies a feed keeps, by Mastodon's `FeedManager`: a reply to its own
 * author or to the viewer always passes. Otherwise home keeps replies to
 * accounts the viewer follows (`filter_from_home`), and a list as its policy
 * says (`filter_from_list?`): `none` drops them, `followed` keeps replies to
 * accounts the owner follows, and `list` keeps replies to the list's members.
 * A reply that answers no one (its parent was not held when it was linked)
 * is dropped, as Mastodon drops one without an `in_reply_to_account_id`. Non-replies are never
 * touched.
 */
const repliesSql = (feed: RepliesFeed, viewerId: string, parent: ReplyParent): SqlFragment => {
  const account = (test: string, bind: string): SqlFragment => ({
    sql: `${parent.account} ${test}`,
    binds: [bind],
  });
  const actor = (test: string, bind: string): SqlFragment => ({
    sql: `${parent.actor} ${test}`,
    binds: [bind],
  });
  const followed = [
    account(`IN ${FOLLOWED_ACCOUNTS_SQL}`, viewerId),
    actor(`IN ${FOLLOWED_ACTORS_SQL}`, viewerId),
  ];
  const byPolicy = (list: ListFeed): SqlFragment[] => {
    switch (list.repliesPolicy) {
      case "followed":
        return followed;
      case "list":
        return [
          account(`IN ${LIST_ACCOUNTS_SQL}`, list.listId),
          actor(`IN ${LIST_ACTORS_SQL}`, list.listId),
        ];
      case "none":
        return [];
    }
  };
  const kept: SqlFragment[] = [
    account("= ?", viewerId),
    { sql: parent.self, binds: [] },
    ...(feed.kind === "Home" ? followed : byPolicy(feed)),
  ];
  return {
    sql: `AND (NOT ${parent.isReply} OR ${kept.map((part) => `(${part.sql})`).join(" OR ")})`,
    binds: kept.flatMap((part) => part.binds),
  };
};

/** Which replies of the remote status `s` the feed keeps. */
export const feedRepliesSql = (feed: FollowedFeed, viewerId: string): SqlFragment =>
  repliesSql(feed, viewerId, {
    isReply: "(s.in_reply_to_uri IS NOT NULL)",
    account: "s.in_reply_to_account_id",
    actor: "s.in_reply_to_actor_uri",
    self: "s.in_reply_to_actor_uri = s.actor_uri",
  });

/** Which replies of the local `statuses` row the feed keeps. */
export const feedLocalRepliesSql = (feed: RepliesFeed, viewerId: string): SqlFragment =>
  repliesSql(feed, viewerId, {
    isReply: "(statuses.in_reply_to_id IS NOT NULL OR statuses.in_reply_to_uri IS NOT NULL)",
    account: "statuses.in_reply_to_account_id",
    actor: "statuses.in_reply_to_actor_uri",
    self: "statuses.in_reply_to_account_id = statuses.account_id",
  });
