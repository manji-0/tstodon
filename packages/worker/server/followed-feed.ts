import { SUPPRESSED_ACCOUNT_IDS_SQL, SUPPRESSED_ACTOR_URIS_SQL } from "./block-mute-store";
import { DOMAIN_SUSPENDED_ACTORS_SQL } from "./domain-hidden-actors";
import { ENTITY_ID_DIGITS } from "./ids";
import type { ListRepliesPolicy } from "./list-store";

/**
 * A timeline fed by the viewer's accepted follows of remote actors: home, or
 * one of the viewer's lists, which holds the followed actors put on it.
 * `localActorPrefix` (`InstanceIdentity.actorUrl(identity, "")`) lets a list
 * recognise a remote reply to one of this instance's posts by its URI.
 */
export type FollowedFeed = Readonly<{ kind: "Home" }> | ListFeed;

export type ListFeed = Readonly<{
  kind: "List";
  listId: string;
  repliesPolicy: ListRepliesPolicy;
  localActorPrefix: string;
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
 * The local boosts (`LocalReblog` rows of `statuses`) a feed of the viewer
 * keeps, by Mastodon's `FeedManager`: the viewer's own always; another's
 * unless the viewer's follow of the booster hides its reblogs, or the viewer
 * does not see the boosted status's author (blocks either way and mutes of a
 * local one, blocks, mutes and domain blocks of a remote one). Notes pass.
 */
export const feedLocalReblogsSql = (viewerId: string, now: string): SqlFragment => {
  const remoteAuthor =
    "COALESCE((SELECT r.actor_uri FROM remote_statuses r WHERE r.id = statuses.reblog_of_remote_id), '')";
  return {
    sql: `AND (
      statuses.kind <> 'LocalReblog' OR statuses.account_id = ? OR (
        statuses.account_id NOT IN (
          SELECT target_account_id FROM follows
          WHERE follower_account_id = ? AND kind = 'Accepted' AND reblogs = 0
        )
        AND COALESCE((SELECT t.account_id FROM statuses t WHERE t.id = statuses.reblog_of_id), '')
          NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL}
        AND ${remoteAuthor} NOT IN ${SUPPRESSED_ACTOR_URIS_SQL}
        AND ${remoteAuthor} NOT IN ${DOMAIN_SUSPENDED_ACTORS_SQL}
      )
    )`,
    binds: [
      viewerId,
      viewerId,
      viewerId,
      viewerId,
      viewerId,
      now,
      viewerId,
      viewerId,
      now,
      viewerId,
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
 * How one side of a feed (local `statuses` or remote `s`) finds who a reply
 * answers. `account` and `actor` are scalar subqueries yielding the parent's
 * local account id or remote actor URI (NULL when it is not one of those);
 * `self` holds when the reply answers its own author.
 */
type ReplyParent = Readonly<{
  isReply: string;
  account: SqlFragment;
  actor: SqlFragment;
  self: string;
}>;

const FOLLOWED_ACCOUNTS_SQL = `(SELECT target_account_id FROM follows WHERE follower_account_id = ? AND kind = 'Accepted')`;
const FOLLOWED_ACTORS_SQL = `(SELECT actor_uri FROM outbound_follows WHERE account_id = ? AND state = 'Accepted')`;
const LIST_ACCOUNTS_SQL = `(SELECT member_account_id FROM account_list_members WHERE list_id = ?)`;
const LIST_ACTORS_SQL = `(SELECT f.actor_uri FROM outbound_follows f
  JOIN account_list_remote_members m ON m.outbound_follow_id = f.id
  WHERE m.list_id = ? AND f.state = 'Accepted')`;

/**
 * The replies a list keeps, by Mastodon's `FeedManager`: a reply to its own
 * author or to the list's owner always passes; otherwise `none` drops it,
 * `followed` keeps replies to accounts the owner follows, and `list` keeps
 * replies to the list's members. Non-replies are never touched.
 */
const listRepliesSql = (feed: ListFeed, viewerId: string, parent: ReplyParent): SqlFragment => {
  const account = (test: string, bind: string): SqlFragment => ({
    sql: `${parent.account.sql} ${test}`,
    binds: [...parent.account.binds, bind],
  });
  const actor = (test: string, bind: string): SqlFragment => ({
    sql: `${parent.actor.sql} ${test}`,
    binds: [...parent.actor.binds, bind],
  });
  const kept: SqlFragment[] = [
    account("= ?", viewerId),
    { sql: parent.self, binds: [] },
    ...(feed.repliesPolicy === "followed"
      ? [
          account(`IN ${FOLLOWED_ACCOUNTS_SQL}`, viewerId),
          actor(`IN ${FOLLOWED_ACTORS_SQL}`, viewerId),
        ]
      : []),
    ...(feed.repliesPolicy === "list"
      ? [
          account(`IN ${LIST_ACCOUNTS_SQL}`, feed.listId),
          actor(`IN ${LIST_ACTORS_SQL}`, feed.listId),
        ]
      : []),
  ];
  return {
    sql: `AND (NOT ${parent.isReply} OR ${kept.map((part) => `(${part.sql})`).join(" OR ")})`,
    binds: kept.flatMap((part) => part.binds),
  };
};

/** Which replies of the remote status `s` the feed keeps; home keeps them all. */
export const feedRepliesSql = (feed: FollowedFeed, viewerId: string): SqlFragment =>
  feed.kind === "Home"
    ? { sql: "", binds: [] }
    : listRepliesSql(feed, viewerId, {
        isReply: "(s.in_reply_to_uri IS NOT NULL)",
        account: {
          // A local status URI ends in `/statuses/<id>` under its author's actor URL.
          sql: `(SELECT l.account_id FROM statuses l JOIN accounts a ON a.id = l.account_id
            WHERE l.id = substr(s.in_reply_to_uri, -${ENTITY_ID_DIGITS})
              AND s.in_reply_to_uri = ? || a.username || '/statuses/' || l.id)`,
          binds: [feed.localActorPrefix],
        },
        actor: {
          sql: "(SELECT rp.actor_uri FROM remote_statuses rp WHERE rp.object_uri = s.in_reply_to_uri)",
          binds: [],
        },
        self: "s.actor_uri = (SELECT rp.actor_uri FROM remote_statuses rp WHERE rp.object_uri = s.in_reply_to_uri)",
      });

/** Which replies of the local `statuses` row a list keeps; home keeps them all. */
export const feedLocalRepliesSql = (feed: FollowedFeed, viewerId: string): SqlFragment =>
  feed.kind === "Home"
    ? { sql: "", binds: [] }
    : listRepliesSql(feed, viewerId, {
        isReply: "(statuses.in_reply_to_id IS NOT NULL OR statuses.in_reply_to_uri IS NOT NULL)",
        account: {
          sql: "(SELECT p.account_id FROM statuses p WHERE p.id = statuses.in_reply_to_id)",
          binds: [],
        },
        actor: {
          sql: "(SELECT rp.actor_uri FROM remote_statuses rp WHERE rp.object_uri = statuses.in_reply_to_uri)",
          binds: [],
        },
        self: "statuses.account_id = (SELECT p.account_id FROM statuses p WHERE p.id = statuses.in_reply_to_id)",
      });
