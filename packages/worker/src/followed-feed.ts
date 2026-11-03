import type { ListRepliesPolicy } from "./list-store";

/**
 * A timeline fed by the viewer's accepted follows of remote actors: home, or
 * one of the viewer's lists, which holds the followed actors put on it.
 */
export type FollowedFeed =
  | Readonly<{ kind: "Home" }>
  | Readonly<{ kind: "List"; listId: string; repliesPolicy: ListRepliesPolicy }>;

type SqlFragment = Readonly<{ sql: string; binds: string[] }>;

/** Narrows the follow `f` to the feed's follows. */
export const feedFollowSql = (feed: FollowedFeed): SqlFragment => {
  switch (feed.kind) {
    case "Home":
      return { sql: "", binds: [] };
    case "List":
      return {
        sql: "AND f.id IN (SELECT outbound_follow_id FROM account_list_remote_members WHERE list_id = ?)",
        binds: [feed.listId],
      };
  }
};

/**
 * Which replies of the remote status `s` the feed keeps: a list's
 * `replies_policy` `none` drops them, `followed` keeps those answering an
 * actor the viewer follows, and `list` (like home) keeps them all.
 */
export const feedRepliesSql = (feed: FollowedFeed, viewerId: string): SqlFragment => {
  if (feed.kind === "Home") {
    return { sql: "", binds: [] };
  }
  switch (feed.repliesPolicy) {
    case "list":
      return { sql: "", binds: [] };
    case "none":
      return { sql: "AND s.in_reply_to_uri IS NULL", binds: [] };
    case "followed":
      return {
        sql: `AND (s.in_reply_to_uri IS NULL OR s.in_reply_to_uri IN (
          SELECT p.object_uri FROM remote_statuses p
          JOIN outbound_follows pf
            ON pf.actor_uri = p.actor_uri AND pf.account_id = ? AND pf.state = 'Accepted'
        ))`,
        binds: [viewerId],
      };
  }
};
