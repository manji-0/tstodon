import { schemaResult } from "@tstodon/core";
import { err, type Result } from "neverthrow";
import type { Hostname } from "@tstodon/domain";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, type RepositoryError, runD1, runD1Batch } from "./d1";
import { newEntityId } from "./ids";
import { parseJsonColumn } from "./json-column";

/**
 * Severed relationships: the follows a moderation decision removed, kept so
 * that the accounts that lost them can see and download the lists (Mastodon's
 * `RelationshipSeveranceEvent`, `AccountRelationshipSeveranceEvent`, and
 * `SeveredRelationship`).
 */

/** Mastodon's event types: a suspended server, a server a user blocked, a suspended remote account. */
export const SeveranceTypeSchema = z.union([
  z.literal("domain_block"),
  z.literal("user_domain_block"),
  z.literal("account_suspension"),
]);

export type SeveranceType = z.infer<typeof SeveranceTypeSchema>;

/** Whose follows a decision removes: every actor of a server, or one actor. */
export type SeveranceScope =
  | Readonly<{ kind: "Domain"; domain: Hostname }>
  | Readonly<{ kind: "Actor"; actorUri: string }>;

/** A decision to sever, as the caller names it. */
export type SeveranceInput = Readonly<{
  scope: SeveranceScope;
  type: SeveranceType;
  /** The domain or account address the event is listed under. */
  targetName: string;
}>;

/** What one local account lost in one event: the row its notification and downloads point at. */
export type AccountSeveranceEvent = Readonly<{
  /** The id the Mastodon API shows as the event's, and the download URLs use. */
  id: string;
  accountId: string;
  type: SeveranceType;
  targetName: string;
  purged: boolean;
  followersCount: number;
  followingCount: number;
  createdAt: string;
}>;

/** Which side of a lost follow the account was on. */
export type SeveranceDirection = "followers" | "following";

/** One line of a download. `followers` have only an address. */
export type SeveredFollow = Readonly<{
  acct: string;
  reblogs: boolean;
  notify: boolean;
  languages: ReadonlyArray<string>;
}>;

/**
 * `(? <> '' AND r.host = ?) OR (? <> '' AND r.actor_uri = ?)` for a scope, `r` being `remote_actors`.
 * A block names a hostname, so it matches `host` and covers every port of it.
 */
const ACTOR_MATCH_SQL = `((? <> '' AND r.host = ?) OR (? <> '' AND r.actor_uri = ?))`;

const matchBinds = (scope: SeveranceScope): [string, string, string, string] => {
  const domain = scope.kind === "Domain" ? scope.domain : "";
  const actorUri = scope.kind === "Actor" ? scope.actorUri : "";
  return [domain, domain, actorUri, actorUri];
};

const MATCHING_ACTORS_SQL = `SELECT r.actor_uri FROM remote_actors r WHERE ${ACTOR_MATCH_SQL}`;

const AccountIdRowSchema = z.object({ local_account_id: z.string() });

/**
 * Record and remove the follows between local accounts and the actors in
 * `scope`: accepted follows by a local account (`outbound_follows`) and of it
 * (`remote_follows`) are written to the event first; requests that were still
 * pending are removed unrecorded, as Mastodon rejects them. One account event
 * is made for each local account that lost a follow. Nothing is written for a
 * decision that affects nobody.
 *
 * It resolves to the account events made, for the caller to notify. The
 * accounts are listed before the batch, so an account that gains its first
 * follow of the scope in between loses it without an event of its own.
 */
export const severRelationships = async (
  db: D1Database,
  input: SeveranceInput,
): Promise<Result<ReadonlyArray<AccountSeveranceEvent>, RepositoryError>> => {
  const binds = matchBinds(input.scope);
  const affected = await runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT local_account_id FROM (
           SELECT o.account_id AS local_account_id
           FROM outbound_follows o JOIN remote_actors r ON r.actor_uri = o.actor_uri
           WHERE o.state = 'Accepted' AND ${ACTOR_MATCH_SQL}
           UNION
           SELECT f.target_account_id
           FROM remote_follows f JOIN remote_actors r ON r.actor_uri = f.remote_actor_uri
           WHERE f.follow_kind = 'Accepted' AND ${ACTOR_MATCH_SQL}
         )`,
      )
      .bind(...binds, ...binds)
      .all();
    return (results ?? []).flatMap((row) => {
      const parsed = schemaResult(AccountIdRowSchema)(row);
      return parsed.isOk() ? [parsed.value.local_account_id] : [];
    });
  });
  if (affected.isErr()) {
    return err(affected.error);
  }
  const now = nowIso();
  const eventId = newEntityId();
  const accountEvents = affected.value.map((accountId) => ({ id: newEntityId(), accountId }));
  const removals = [
    db
      .prepare(`DELETE FROM outbound_follows WHERE actor_uri IN (${MATCHING_ACTORS_SQL})`)
      .bind(...binds),
    db
      .prepare(`DELETE FROM remote_follows WHERE remote_actor_uri IN (${MATCHING_ACTORS_SQL})`)
      .bind(...binds),
  ];
  if (accountEvents.length === 0) {
    const removed = await runD1Batch(db, removals);
    return removed.map(() => []);
  }
  const written = await runD1Batch(db, [
    db
      .prepare(
        `INSERT INTO relationship_severance_events (id, type, target_name, purged, created_at)
         VALUES (?, ?, ?, 0, ?)`,
      )
      .bind(eventId, input.type, input.targetName, now),
    db
      .prepare(
        `INSERT INTO severed_relationships
           (id, event_id, local_account_id, remote_acct, direction, show_reblogs, notify, languages_json, created_at)
         SELECT o.id, ?, o.account_id, r.username || '@' || r.domain, 'active',
                o.reblogs, o.notify, o.languages_json, ?
         FROM outbound_follows o JOIN remote_actors r ON r.actor_uri = o.actor_uri
         WHERE o.state = 'Accepted' AND ${ACTOR_MATCH_SQL}`,
      )
      .bind(eventId, now, ...binds),
    db
      .prepare(
        `INSERT INTO severed_relationships
           (id, event_id, local_account_id, remote_acct, direction, show_reblogs, notify, languages_json, created_at)
         SELECT f.id, ?, f.target_account_id, r.username || '@' || r.domain, 'passive',
                NULL, NULL, NULL, ?
         FROM remote_follows f JOIN remote_actors r ON r.actor_uri = f.remote_actor_uri
         WHERE f.follow_kind = 'Accepted' AND ${ACTOR_MATCH_SQL}`,
      )
      .bind(eventId, now, ...binds),
    ...accountEvents.map(({ id, accountId }) =>
      db
        .prepare(
          `INSERT INTO account_severance_events
             (id, event_id, account_id, followers_count, following_count, created_at)
           VALUES (?, ?, ?,
             (SELECT COUNT(*) FROM severed_relationships
                WHERE event_id = ? AND local_account_id = ? AND direction = 'passive'),
             (SELECT COUNT(*) FROM severed_relationships
                WHERE event_id = ? AND local_account_id = ? AND direction = 'active'),
             ?)`,
        )
        .bind(id, eventId, accountId, eventId, accountId, eventId, accountId, now),
    ),
    ...removals,
  ]);
  if (written.isErr()) {
    return err(written.error);
  }
  return findAccountSeveranceEvents(
    db,
    accountEvents.map(({ id }) => id),
  );
};

/**
 * A remote actor on a domain an account blocked, and which follows between
 * the two the block removes: the account's accepted follow of it, and its
 * follow of the account, accepted or requested.
 */
export type DomainFollowPeer = Readonly<{
  actorUri: string;
  following: boolean;
  follower: boolean;
}>;

const DomainFollowPeerRowSchema = z.object({
  actor_uri: z.string(),
  following: z.number(),
  follower: z.number(),
});

/**
 * The next `limit` actors on `domain` (every port of it), after `afterActorUri`
 * in URI order, that `accountId` follows (accepted) or that follow or ask to
 * follow it. The account's own pending requests stay, as Mastodon's
 * `AfterBlockDomainFromAccountService` only unfollows accepted follows.
 */
export const listDomainFollowPeers = async (
  db: D1Database,
  accountId: string,
  domain: Hostname,
  afterActorUri: string,
  limit: number,
): Promise<Result<DomainFollowPeer[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT actor_uri, MAX(following) AS following, MAX(follower) AS follower FROM (
           SELECT o.actor_uri, 1 AS following, 0 AS follower
           FROM outbound_follows o JOIN remote_actors r ON r.actor_uri = o.actor_uri
           WHERE o.account_id = ? AND o.state = 'Accepted' AND r.host = ?
           UNION ALL
           SELECT f.remote_actor_uri, 0, 1
           FROM remote_follows f JOIN remote_actors r ON r.actor_uri = f.remote_actor_uri
           WHERE f.target_account_id = ? AND r.host = ?
         )
         WHERE actor_uri > ?
         GROUP BY actor_uri ORDER BY actor_uri LIMIT ?`,
      )
      .bind(accountId, domain, accountId, domain, afterActorUri, limit)
      .all();
    return (results ?? []).flatMap((raw) => {
      const row = schemaResult(DomainFollowPeerRowSchema)(raw);
      return row.isOk()
        ? [
            {
              actorUri: row.value.actor_uri,
              following: row.value.following !== 0,
              follower: row.value.follower !== 0,
            },
          ]
        : [];
    });
  });

/** One page of a severance recorded over several calls, for one local account. */
export type AccountSeverancePage = Readonly<{
  eventId: string;
  type: SeveranceType;
  targetName: string;
  accountId: string;
  actorUris: ReadonlyArray<string>;
}>;

/**
 * Record the accepted follows between `accountId` and `actorUris`, both ways,
 * under `eventId`, before the caller removes them. The event is written with
 * the first page that has a follow to record, so a severance that only drops
 * requests leaves none. Recording a page twice keeps one row per follow.
 */
export const recordAccountSeverancePage = async (
  db: D1Database,
  page: AccountSeverancePage,
): Promise<Result<void, RepositoryError>> => {
  const now = nowIso();
  const actors = jsonStringArray(page.actorUris);
  const active = `FROM outbound_follows o JOIN remote_actors r ON r.actor_uri = o.actor_uri
     WHERE o.account_id = ? AND o.state = 'Accepted'
       AND o.actor_uri IN (SELECT value FROM json_each(?))`;
  const passive = `FROM remote_follows f JOIN remote_actors r ON r.actor_uri = f.remote_actor_uri
     WHERE f.target_account_id = ? AND f.follow_kind = 'Accepted'
       AND f.remote_actor_uri IN (SELECT value FROM json_each(?))`;
  const written = await runD1Batch(db, [
    db
      .prepare(
        `INSERT OR IGNORE INTO relationship_severance_events (id, type, target_name, purged, created_at)
         SELECT ?, ?, ?, 0, ?
         WHERE EXISTS (SELECT 1 ${active}) OR EXISTS (SELECT 1 ${passive})`,
      )
      .bind(
        page.eventId,
        page.type,
        page.targetName,
        now,
        page.accountId,
        actors,
        page.accountId,
        actors,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO severed_relationships
           (id, event_id, local_account_id, remote_acct, direction, show_reblogs, notify, languages_json, created_at)
         SELECT o.id, ?, o.account_id, r.username || '@' || r.domain, 'active',
                o.reblogs, o.notify, o.languages_json, ?
         ${active}`,
      )
      .bind(page.eventId, now, page.accountId, actors),
    db
      .prepare(
        `INSERT OR IGNORE INTO severed_relationships
           (id, event_id, local_account_id, remote_acct, direction, show_reblogs, notify, languages_json, created_at)
         SELECT f.id, ?, f.target_account_id, r.username || '@' || r.domain, 'passive',
                NULL, NULL, NULL, ?
         ${passive}`,
      )
      .bind(page.eventId, now, page.accountId, actors),
  ]);
  return written.map(() => undefined);
};

const IdRowSchema = z.object({ id: z.string() });

/**
 * Close a severance recorded with {@link recordAccountSeverancePage}: write
 * the account's event with its counts and resolve to it, for the caller to
 * notify. It resolves to none when nothing was recorded, or when an earlier
 * call already wrote the account event.
 */
export const finishAccountSeverance = async (
  db: D1Database,
  eventId: string,
  accountId: string,
): Promise<Result<AccountSeveranceEvent | undefined, RepositoryError>> => {
  const inserted = await runD1(async () => {
    const { results } = await db
      .prepare(
        `INSERT OR IGNORE INTO account_severance_events
           (id, event_id, account_id, followers_count, following_count, created_at)
         SELECT ?, ?, ?,
           (SELECT COUNT(*) FROM severed_relationships
              WHERE event_id = ? AND local_account_id = ? AND direction = 'passive'),
           (SELECT COUNT(*) FROM severed_relationships
              WHERE event_id = ? AND local_account_id = ? AND direction = 'active'),
           ?
         WHERE EXISTS (SELECT 1 FROM severed_relationships WHERE event_id = ? AND local_account_id = ?)
         RETURNING id`,
      )
      .bind(
        newEntityId(),
        eventId,
        accountId,
        eventId,
        accountId,
        eventId,
        accountId,
        nowIso(),
        eventId,
        accountId,
      )
      .all();
    return (results ?? []).flatMap((raw) => {
      const row = schemaResult(IdRowSchema)(raw);
      return row.isOk() ? [row.value.id] : [];
    });
  });
  if (inserted.isErr()) {
    return err(inserted.error);
  }
  const events = await findAccountSeveranceEvents(db, inserted.value);
  return events.map((found) => found[0]);
};

const EventRowSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  type: SeveranceTypeSchema,
  target_name: z.string(),
  purged: z.number(),
  followers_count: z.number(),
  following_count: z.number(),
  created_at: z.string(),
});

const EVENT_SELECT = `SELECT a.id, a.account_id, e.type, e.target_name, e.purged,
       a.followers_count, a.following_count, a.created_at
FROM account_severance_events a
JOIN relationship_severance_events e ON e.id = a.event_id`;

const eventFromRow = (raw: unknown): AccountSeveranceEvent[] => {
  const row = schemaResult(EventRowSchema)(raw);
  return row.isOk()
    ? [
        {
          id: row.value.id,
          accountId: row.value.account_id,
          type: row.value.type,
          targetName: row.value.target_name,
          purged: row.value.purged !== 0,
          followersCount: row.value.followers_count,
          followingCount: row.value.following_count,
          createdAt: row.value.created_at,
        },
      ]
    : [];
};

/** Account events by id (any account's), for notifications and the entity they carry. */
export const findAccountSeveranceEvents = async (
  db: D1Database,
  ids: ReadonlyArray<string>,
): Promise<Result<AccountSeveranceEvent[], RepositoryError>> =>
  runD1(async () => {
    if (ids.length === 0) {
      return [];
    }
    const { results } = await db
      .prepare(`${EVENT_SELECT} WHERE a.id IN (SELECT value FROM json_each(?)) ORDER BY a.id`)
      .bind(jsonStringArray(ids))
      .all();
    return (results ?? []).flatMap(eventFromRow);
  });

/** Most events `/severed_relationships` lists; the newest. Mastodon lists all of them. */
export const SEVERED_EVENTS_SHOWN = 200;

/** The account's events, newest first. */
export const listAccountSeveranceEvents = async (
  db: D1Database,
  accountId: string,
): Promise<Result<AccountSeveranceEvent[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(`${EVENT_SELECT} WHERE a.account_id = ? ORDER BY a.id DESC LIMIT ?`)
      .bind(accountId, SEVERED_EVENTS_SHOWN)
      .all();
    return (results ?? []).flatMap(eventFromRow);
  });

/** One of the account's own events; another account's id reads as none. */
export const findOwnSeveranceEvent = async (
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Result<AccountSeveranceEvent | undefined, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(`${EVENT_SELECT} WHERE a.id = ? AND a.account_id = ?`)
      .bind(id, accountId)
      .all();
    return (results ?? []).flatMap(eventFromRow)[0];
  });

const FollowRowSchema = z.object({
  remote_acct: z.string(),
  show_reblogs: z.number().nullable(),
  notify: z.number().nullable(),
  languages_json: z.string().nullable(),
});

/** The follows an account lost in an event on one side, newest first (Mastodon's `reorder(id: :desc)`). */
export const listSeveredFollows = async (
  db: D1Database,
  event: AccountSeveranceEvent,
  direction: SeveranceDirection,
): Promise<Result<SeveredFollow[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT s.remote_acct, s.show_reblogs, s.notify, s.languages_json
         FROM severed_relationships s
         JOIN account_severance_events a ON a.event_id = s.event_id AND a.account_id = s.local_account_id
         WHERE a.id = ? AND s.direction = ?
         ORDER BY s.id DESC`,
      )
      .bind(event.id, direction === "following" ? "active" : "passive")
      .all();
    return (results ?? []).flatMap((raw) => {
      const row = schemaResult(FollowRowSchema)(raw);
      return row.isOk()
        ? [
            {
              acct: row.value.remote_acct,
              reblogs: row.value.show_reblogs !== 0,
              notify: row.value.notify === 1,
              languages: row.value.languages_json
                ? parseJsonColumn(z.array(z.string()), row.value.languages_json).unwrapOr([])
                : [],
            },
          ]
        : [];
    });
  });

/** Mastodon's `RelationshipSeveranceEvent` entity inside a `severed_relationships` notification. */
export const severanceEventDocument = (event: AccountSeveranceEvent): Record<string, unknown> => ({
  id: event.id,
  type: event.type,
  purged: event.purged,
  target_name: event.targetName,
  followers_count: event.followersCount,
  following_count: event.followingCount,
  created_at: event.createdAt,
});
