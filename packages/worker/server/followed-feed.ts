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
          // A silent mention is not an active one (`Mention.active`).
          probe("status_mentions", status.local, `m.silent = 0 AND ${accounts}`),
          probe("status_remote_mentions", status.local, `m.silent = 0 AND ${actors}`),
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
 * How deep a home page reads the indexes of the followed hashtags together
 * below its cursor, as a multiple of the page's size. Past that the page
 * stops at the {@link followedTagHorizonSql horizon}.
 */
export const HOME_FOLLOWED_TAG_DEPTH = 4;

/**
 * How many followed hashtags home reads, the most recently followed first.
 * Mastodon reads none on a home page and sets no limit on them: it delivers
 * each post to its hashtags' followers once
 * (`FanOutOnWriteService#deliver_to_hashtag_followers`). Here a page costs a
 * few rows per followed hashtag, so this keeps a page's cost bounded for an
 * account that follows a great many.
 */
export const HOME_FOLLOWED_TAG_LIMIT = 1000;

/**
 * The CTE `ft(tag_name, floor)`: the viewer's {@link HOME_FOLLOWED_TAG_LIMIT}
 * most recently followed hashtags, with the id floor of each follow. For a
 * single entry (`onlyId`, the streaming fan-out's question), the followed
 * hashtags among the entry's, found from its tags and the follow's primary
 * key rather than from every hashtag the viewer follows: ranking the follow
 * against the limit would read the follows newer than it, so a viewer past
 * the limit hears an entry under an older hashtag that a page does not
 * show. Binds the viewer, then the entry for `onlyId`.
 */
const followedTagsCte = (tags: string, onlyId: boolean): string => {
  const floor = `printf('%0${ENTITY_ID_DIGITS}d',
      CAST(round((julianday(f.created_at) - 2440587.5) * 86400000) AS INTEGER) << 16) AS floor`;
  return onlyId
    ? `ft AS (
      SELECT f.tag_name, ${floor} FROM followed_tags f
      WHERE f.account_id = ? AND f.tag_name IN (SELECT tag FROM ${tags} WHERE status_id = ?)
    )`
    : `ft AS (
      SELECT f.tag_name, ${floor} FROM followed_tags f WHERE f.account_id = ?
      ORDER BY f.created_at DESC, f.rowid LIMIT ${HOME_FOLLOWED_TAG_LIMIT}
    )`;
};

/**
 * The bounds on a tag index row `t` of followed hashtag `ft`: its id floor,
 * the cursor's bounds (the CTE `c(lo, hi)`) and, when `horizon` is given, the
 * horizon (the CTE `w(h)`). Every lower bound is folded into one `max(...)`,
 * so SQLite starts the index range at the highest of them.
 */
const tagIndexBounds = (
  cursor: IdCursor,
  horizon: boolean,
): Readonly<{ bounds: readonly [string, string]; sql: string }> => {
  const { onlyId, after, before, ascending } = idCursorBounds(cursor);
  if (onlyId.length > 0) {
    return {
      bounds: [onlyId, ""],
      sql: "t.status_id = (SELECT lo FROM c) AND t.status_id >= ft.floor",
    };
  }
  const lower = [
    "ft.floor",
    ...(after.length > 0 ? ["(SELECT lo FROM c)"] : []),
    ...(horizon && !ascending ? ["(SELECT h FROM w)"] : []),
  ];
  return {
    bounds: [after, before],
    sql: [
      `t.status_id >= ${lower.length > 1 ? `max(${lower.join(", ")})` : lower[0]}`,
      ...(after.length > 0 ? ["t.status_id <> (SELECT lo FROM c)"] : []),
      ...(before.length > 0 ? ["t.status_id < (SELECT hi FROM c)"] : []),
      ...(horizon && ascending ? ["t.status_id <= (SELECT h FROM w)"] : []),
    ].join(" AND "),
  };
};

/**
 * How far a home page can vouch for the notes under the viewer's followed
 * hashtags: the note {@link HOME_FOLLOWED_TAG_DEPTH} pages below the cursor
 * (above it for a `min_id` page) in the local and remote indexes of all of
 * them together, a note under several of them counted once, or NULL when
 * they hold fewer. A recursive CTE merges the indexes: its queue holds the
 * next entry of each hashtag and side, newest first (oldest for `min_id`),
 * and each entry it takes queues the one after it in the same index. The
 * outer `LIMIT` stops it there, so a page reads two index seeks per followed
 * hashtag and one per entry it passes, however many notes the hashtags hold.
 * Hidden notes count, so a hidden flood costs a bounded read. One row,
 * `horizon`.
 */
export const followedTagHorizonSql = (
  viewerId: string,
  cursor: IdCursor,
  limit: number,
): SqlFragment => {
  const { bounds, sql: within } = tagIndexBounds(cursor, false);
  const { after, before, ascending } = idCursorBounds(cursor);
  const order = ascending ? "ASC" : "DESC";
  const deep = Math.max(1, Math.trunc(limit) * HOME_FOLLOWED_TAG_DEPTH) - 1;
  // The entry after `ft.id` replaces the cursor's bound on the side the merge
  // walks from, so SQLite seeks from it rather than scan to it.
  const past = ascending
    ? ["t.status_id > ft.id", ...(before.length > 0 ? ["t.status_id < (SELECT hi FROM c)"] : [])]
    : [
        "t.status_id < ft.id",
        `t.status_id >= ${after.length > 0 ? "max(ft.floor, (SELECT lo FROM c))" : "ft.floor"}`,
        ...(after.length > 0 ? ["t.status_id <> (SELECT lo FROM c)"] : []),
      ];
  const next = (tags: string, where: string): string => `(
      SELECT t.status_id FROM ${tags} t
      WHERE t.tag = ft.tag_name AND ${where}
      ORDER BY t.status_id ${order} LIMIT 1
    )`;
  return {
    sql: `WITH RECURSIVE ${followedTagsCte("", false)}, c(lo, hi) AS (SELECT ?, ?),
      merged(id, side, tag_name, floor) AS (
        SELECT * FROM (
          SELECT ${next("local_status_tags", within)} AS id, 0, tag_name, floor FROM ft
          UNION ALL SELECT ${next("remote_status_tags", within)}, 1, tag_name, floor FROM ft
        ) WHERE id IS NOT NULL
        UNION ALL SELECT CASE ft.side
            WHEN 0 THEN ${next("local_status_tags", past.join(" AND "))}
            ELSE ${next("remote_status_tags", past.join(" AND "))}
          END, ft.side, ft.tag_name, ft.floor
        FROM merged AS ft WHERE ft.id IS NOT NULL
        ORDER BY 1 ${order}
      )
      SELECT (
        SELECT DISTINCT id FROM merged WHERE id IS NOT NULL LIMIT 1 OFFSET ${deep}
      ) AS horizon`,
    binds: [viewerId, ...bounds],
  };
};

/**
 * The ids of the notes a followed hashtag brings to the viewer's home page,
 * as Mastodon's `deliver_to_hashtag_followers`: public notes (not of a
 * silenced or suspended local author), posted or received since the viewer
 * followed the hashtag. An id sorts by the instant it was made at, so
 * "since the follow" is an id floor: the follow's instant shifted above the
 * id's low 16 bits (`entityIdAt`). The side's `hidden` authors are left out.
 * The ids lie within `cursor` and, when the page has a `horizon`
 * ({@link followedTagHorizonSql}), not past it, so a page reads a bounded
 * depth of the hashtags' indexes however many notes they hold or hide. The
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
  const { bounds, sql: within } = tagIndexBounds(cursor, horizon !== undefined);
  const { onlyId } = idCursorBounds(cursor);
  return {
    sql: `(
      WITH ${followedTagsCte(tags, onlyId.length > 0)}, c(lo, hi) AS (SELECT ?, ?), w(h) AS (SELECT ?),
      hidden(id) AS MATERIALIZED (
        ${hidden.sql}
      )
      SELECT DISTINCT t.status_id FROM ft
      CROSS JOIN ${tags} t
      CROSS JOIN ${notes} n ON n.id = t.status_id
      WHERE t.tag = ft.tag_name AND ${within} AND ${shown}
    )`,
    binds: [
      viewerId,
      ...(onlyId.length > 0 ? [onlyId] : []),
      ...bounds,
      horizon ?? "",
      ...hidden.binds,
    ],
  };
};

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
