import { InstanceIdentity, type ImportTypeValue } from "@tstodon/domain";
import { z } from "zod";
import { type Result } from "neverthrow";
import { listMemberKey } from "./csv-import-file";
import { parseRows, type RepositoryError, runD1 } from "./d1";
import { nowIso } from "./clock";
import { parseJsonColumn } from "./json-column";
import type { ListMember } from "./list-store";

/**
 * The entries an account has of each import type, a page at a time: what an
 * export writes and what an overwrite import compares its file with. Every
 * entry has the `key` that a file row naming it has (see `accountKey`), and a
 * `cursor` that orders the pages.
 */

/** Who a follow, block, or mute targets: a local account or a cached remote actor. */
export type EntryTarget =
  | Readonly<{ kind: "LocalAccount"; accountId: string; actorUri: string }>
  | Readonly<{ kind: "RemoteActor"; actorUri: string }>;

/**
 * `key` is the entry's `user@domain` (the domain is the actor's host, which
 * can differ from the WebFinger domain of its handle); `resolved` is what a
 * file row that resolved to this entry records (see `csv_import_rows.resolved`).
 */
type Base = Readonly<{ cursor: string; key: string; resolved: string }>;

export type Entry =
  | (Base &
      Readonly<{
        kind: "Following";
        acct: string;
        target: EntryTarget;
        reblogs: boolean;
        notify: boolean;
        languages: ReadonlyArray<string>;
      }>)
  | (Base & Readonly<{ kind: "Blocks"; acct: string; target: EntryTarget }>)
  | (Base &
      Readonly<{ kind: "Mutes"; acct: string; target: EntryTarget; hideNotifications: boolean }>)
  | (Base & Readonly<{ kind: "DomainBlocks"; domain: string }>)
  | (Base &
      Readonly<{
        kind: "Lists";
        listId: string;
        title: string;
        acct: string;
        member: ListMember;
      }>)
  | (Base & Readonly<{ kind: "Bookmarks"; statusId: string; uri: string }>);

/** Where a page of entries ends: the cursor to continue after, or none when it was the last page. */
export type EntryPage = Readonly<{ entries: ReadonlyArray<Entry>; next: string | undefined }>;

const PersonColumns = {
  username: z.string().nullable(),
  domain: z.string().nullable(),
  account_id: z.string().nullable(),
  actor_uri: z.string(),
};

/**
 * The `user@domain` of a row's person, and whom it targets. A remote domain
 * is the host of the actor URI: the WebFinger domain of its handle (what
 * Mastodon exports) is not stored, so an export writes the host.
 * `undefined` for a person no longer known.
 */
const person = (
  identity: InstanceIdentity,
  row: Readonly<{
    username: string | null;
    domain: string | null;
    account_id: string | null;
    actor_uri: string;
  }>,
): Readonly<{ acct: string; target: EntryTarget }> | undefined => {
  if (row.username === null) {
    return undefined;
  }
  if (row.account_id !== null) {
    return {
      acct: `${row.username}@${identity.domain}`,
      target: { kind: "LocalAccount", accountId: row.account_id, actorUri: row.actor_uri },
    };
  }
  return row.domain === null
    ? undefined
    : {
        acct: `${row.username}@${row.domain}`,
        target: { kind: "RemoteActor", actorUri: row.actor_uri },
      };
};

const page = (
  entries: ReadonlyArray<Entry>,
  cursors: ReadonlyArray<string>,
  limit: number,
): EntryPage => ({
  entries,
  // A full page may have more after it; the cursor is the last row read, kept or not.
  next: cursors.length >= limit ? cursors.at(-1) : undefined,
});

const FollowingRow = z.object({
  cursor: z.string(),
  ...PersonColumns,
  reblogs: z.number(),
  notify: z.number(),
  languages_json: z.string(),
});

const followingPage = (
  db: D1Database,
  identity: InstanceIdentity,
  accountId: string,
  after: string,
  limit: number,
): Promise<Result<EntryPage, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT cursor, username, domain, account_id, actor_uri, reblogs, notify, languages_json FROM (
           SELECT f.id AS cursor, a.username AS username, NULL AS domain,
                  f.target_account_id AS account_id,
                  ? || a.username AS actor_uri,
                  f.reblogs, f.notify, f.languages_json
           FROM follows f JOIN accounts a ON a.id = f.target_account_id
           WHERE f.follower_account_id = ? AND f.kind = 'Accepted'
           UNION ALL
           SELECT o.id, r.username, r.domain, NULL, o.actor_uri,
                  o.reblogs, o.notify, o.languages_json
           FROM outbound_follows o JOIN remote_actors r ON r.actor_uri = o.actor_uri
           WHERE o.account_id = ? AND o.state = 'Accepted'
         ) WHERE cursor > ? ORDER BY cursor LIMIT ?`,
      )
      .bind(`${InstanceIdentity.actorUrl(identity, "")}`, accountId, accountId, after, limit)
      .all();
    const rows = parseRows(FollowingRow, results);
    const entries = rows.flatMap((row): Entry[] => {
      const who = person(identity, row);
      return who
        ? [
            {
              kind: "Following",
              cursor: row.cursor,
              key: who.acct.toLowerCase(),
              resolved: who.target.actorUri,
              acct: who.acct,
              target: who.target,
              reblogs: row.reblogs !== 0,
              notify: row.notify !== 0,
              languages: parseJsonColumn(z.array(z.string()), row.languages_json).unwrapOr([]),
            },
          ]
        : [];
    });
    return page(
      entries,
      rows.map((row) => row.cursor),
      limit,
    );
  });

const BlockRow = z.object({ cursor: z.string(), ...PersonColumns });

const blocksPage = (
  db: D1Database,
  identity: InstanceIdentity,
  accountId: string,
  after: string,
  limit: number,
): Promise<Result<EntryPage, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT b.target_actor_uri AS cursor, b.target_actor_uri AS actor_uri,
                b.target_account_id AS account_id,
                COALESCE(a.username, r.username) AS username, r.domain AS domain
         FROM blocks b
         LEFT JOIN accounts a ON a.id = b.target_account_id
         LEFT JOIN remote_actors r ON r.actor_uri = b.target_actor_uri
         WHERE b.blocker_account_id = ? AND b.target_actor_uri > ?
         ORDER BY b.target_actor_uri LIMIT ?`,
      )
      .bind(accountId, after, limit)
      .all();
    const rows = parseRows(BlockRow, results);
    const entries = rows.flatMap((row): Entry[] => {
      const who = person(identity, row);
      return who
        ? [
            {
              kind: "Blocks",
              cursor: row.cursor,
              key: who.acct.toLowerCase(),
              resolved: who.target.actorUri,
              ...who,
            },
          ]
        : [];
    });
    return page(
      entries,
      rows.map((row) => row.cursor),
      limit,
    );
  });

const MuteRow = z.object({ cursor: z.string(), ...PersonColumns, notifications: z.number() });

const mutesPage = (
  db: D1Database,
  identity: InstanceIdentity,
  accountId: string,
  after: string,
  limit: number,
): Promise<Result<EntryPage, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT m.target_actor_uri AS cursor, m.target_actor_uri AS actor_uri,
                m.target_account_id AS account_id, m.notifications AS notifications,
                COALESCE(a.username, r.username) AS username, r.domain AS domain
         FROM mutes m
         LEFT JOIN accounts a ON a.id = m.target_account_id
         LEFT JOIN remote_actors r ON r.actor_uri = m.target_actor_uri
         WHERE m.account_id = ? AND m.target_actor_uri > ?
           AND (m.expires_at IS NULL OR m.expires_at > ?)
         ORDER BY m.target_actor_uri LIMIT ?`,
      )
      .bind(accountId, after, nowIso(), limit)
      .all();
    const rows = parseRows(MuteRow, results);
    const entries = rows.flatMap((row): Entry[] => {
      const who = person(identity, row);
      return who
        ? [
            {
              kind: "Mutes",
              cursor: row.cursor,
              key: who.acct.toLowerCase(),
              resolved: who.target.actorUri,
              ...who,
              hideNotifications: row.notifications !== 0,
            },
          ]
        : [];
    });
    return page(
      entries,
      rows.map((row) => row.cursor),
      limit,
    );
  });

const domainBlocksPage = (
  db: D1Database,
  accountId: string,
  after: string,
  limit: number,
): Promise<Result<EntryPage, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT domain FROM account_domain_blocks
         WHERE account_id = ? AND domain > ? ORDER BY domain LIMIT ?`,
      )
      .bind(accountId, after, limit)
      .all();
    const rows = parseRows(z.object({ domain: z.string() }), results);
    return page(
      rows.map((row): Entry => ({
        kind: "DomainBlocks",
        cursor: row.domain,
        key: row.domain,
        resolved: row.domain,
        domain: row.domain,
      })),
      rows.map((row) => row.domain),
      limit,
    );
  });

const ListMemberRow = z.object({
  cursor: z.string(),
  list_id: z.string(),
  title: z.string(),
  ...PersonColumns,
});

const listsPage = (
  db: D1Database,
  identity: InstanceIdentity,
  accountId: string,
  after: string,
  limit: number,
): Promise<Result<EntryPage, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT cursor, list_id, title, username, domain, account_id, actor_uri FROM (
           SELECT l.id || '/L/' || m.member_account_id AS cursor, l.id AS list_id, l.title AS title,
                  a.username AS username, NULL AS domain, a.id AS account_id,
                  ? || a.username AS actor_uri
           FROM account_lists l
           JOIN account_list_members m ON m.list_id = l.id
           JOIN accounts a ON a.id = m.member_account_id
           WHERE l.account_id = ?
           UNION ALL
           SELECT l.id || '/R/' || f.actor_uri, l.id, l.title,
                  r.username, r.domain, NULL, f.actor_uri
           FROM account_lists l
           JOIN account_list_remote_members m ON m.list_id = l.id
           JOIN outbound_follows f ON f.id = m.outbound_follow_id
           JOIN remote_actors r ON r.actor_uri = f.actor_uri
           WHERE l.account_id = ?
         ) WHERE cursor > ? ORDER BY cursor LIMIT ?`,
      )
      .bind(InstanceIdentity.actorUrl(identity, ""), accountId, accountId, after, limit)
      .all();
    const rows = parseRows(ListMemberRow, results);
    const entries = rows.flatMap((row): Entry[] => {
      const who = person(identity, row);
      if (!who) {
        return [];
      }
      const member: ListMember =
        who.target.kind === "LocalAccount"
          ? { kind: "LocalAccount", accountId: who.target.accountId }
          : { kind: "RemoteActor", actorUri: who.target.actorUri };
      return [
        {
          kind: "Lists",
          cursor: row.cursor,
          key: listMemberKey(row.title, who.acct.toLowerCase()),
          resolved: listMemberKey(row.title, who.target.actorUri),
          listId: row.list_id,
          title: row.title,
          acct: who.acct,
          member,
        },
      ];
    });
    return page(
      entries,
      rows.map((row) => row.cursor),
      limit,
    );
  });

const bookmarksPage = (
  db: D1Database,
  identity: InstanceIdentity,
  accountId: string,
  after: string,
  limit: number,
): Promise<Result<EntryPage, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT b.status_id AS status_id, a.username AS username
         FROM bookmarks b
         JOIN statuses s ON s.id = b.status_id
         JOIN accounts a ON a.id = s.account_id
         WHERE b.account_id = ? AND b.status_id > ? ORDER BY b.status_id LIMIT ?`,
      )
      .bind(accountId, after, limit)
      .all();
    const rows = parseRows(z.object({ status_id: z.string(), username: z.string() }), results);
    return page(
      rows.map((row): Entry => ({
        kind: "Bookmarks",
        cursor: row.status_id,
        key: row.status_id,
        resolved: row.status_id,
        statusId: row.status_id,
        uri: `${InstanceIdentity.actorUrl(identity, row.username)}/statuses/${row.status_id}`,
      })),
      rows.map((row) => row.status_id),
      limit,
    );
  });

/**
 * Up to `limit` entries of `type` for `accountId` after the cursor `after`
 * (empty for the first page). A full page names the cursor of the next one;
 * a page can hold fewer entries than `limit` yet have a next, when an entry
 * is skipped (a remote actor no longer cached).
 */
export const listEntriesPage = (
  db: D1Database,
  identity: InstanceIdentity,
  accountId: string,
  type: ImportTypeValue,
  after: string,
  limit: number,
): Promise<Result<EntryPage, RepositoryError>> => {
  switch (type.kind) {
    case "Following":
      return followingPage(db, identity, accountId, after, limit);
    case "Blocks":
      return blocksPage(db, identity, accountId, after, limit);
    case "Mutes":
      return mutesPage(db, identity, accountId, after, limit);
    case "DomainBlocks":
      return domainBlocksPage(db, accountId, after, limit);
    case "Lists":
      return listsPage(db, identity, accountId, after, limit);
    case "Bookmarks":
      return bookmarksPage(db, identity, accountId, after, limit);
  }
};
