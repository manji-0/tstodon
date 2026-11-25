import { normalizeHashtag } from "@tstodon/core";
import { Collection, type CollectionItemState } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import {
  jsonStringArray,
  parseRows,
  type RepositoryError,
  runD1,
  runD1Batch,
  sqlInJsonEach,
} from "./d1";
import { recordTagNames } from "./hashtags";
import { RemoteAccountId } from "./remote-account-id";

const CollectionRow = z.object({
  id: z.string(),
  account_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  language: z.string().nullable(),
  sensitive: z.number(),
  discoverable: z.number(),
  tag_name: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
type CollectionRow = z.infer<typeof CollectionRow>;

const ItemRow = z.object({
  id: z.string(),
  collection_id: z.string(),
  account_id: z.string().nullable(),
  actor_uri: z.string().nullable(),
  position: z.number(),
  state: z.string(),
  activity_uri: z.string().nullable(),
  approval_uri: z.string().nullable(),
  created_at: z.string(),
});
type ItemRow = z.infer<typeof ItemRow>;

const CountRow = z.object({ count: z.number() });

const COLLECTION_COLUMNS =
  "c.id, c.account_id, c.name, c.description, c.language, c.sensitive, c.discoverable, c.tag_name, c.created_at, c.updated_at";

/** Collections with their items; a row that does not parse into the domain model is left out. */
const withItems = async (
  db: D1Database,
  rows: ReadonlyArray<CollectionRow>,
): Promise<Collection[]> => {
  if (rows.length === 0) {
    return [];
  }
  const { results } = await db
    .prepare(
      `SELECT id, collection_id, account_id, actor_uri, position, state, activity_uri, approval_uri,
         created_at FROM collection_items
       WHERE collection_id ${sqlInJsonEach()} ORDER BY position, id`,
    )
    .bind(jsonStringArray(rows.map((row) => row.id)))
    .all();
  const items = new Map<string, ItemRow[]>();
  for (const item of parseRows(ItemRow, results)) {
    items.set(item.collection_id, [...(items.get(item.collection_id) ?? []), item]);
  }
  return rows.flatMap((row) => {
    const parsed = Collection.parse({
      kind: "LocalCollection",
      id: row.id,
      accountId: row.account_id,
      name: row.name,
      description: row.description,
      language: row.language,
      sensitive: row.sensitive !== 0,
      discoverable: row.discoverable !== 0,
      tagName: row.tag_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items: (items.get(row.id) ?? []).map((item) => ({
        id: item.id,
        accountId: item.account_id ?? RemoteAccountId.encode(item.actor_uri ?? ""),
        position: item.position,
        state: item.state,
        createdAt: item.created_at,
        ...(item.activity_uri === null ? {} : { activityUri: item.activity_uri }),
        ...(item.approval_uri === null ? {} : { approvalUri: item.approval_uri }),
      })),
    });
    return parsed.isOk() ? [parsed.value] : [];
  });
};

export const findCollection = async (
  db: D1Database,
  id: string,
): Promise<Result<Collection | undefined, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(`SELECT ${COLLECTION_COLUMNS} FROM collections c WHERE c.id = ?`)
      .bind(id)
      .all();
    const [found] = await withItems(db, parseRows(CollectionRow, results));
    return found;
  });

/** The collection holding the item `itemId`. */
export const findCollectionOfItem = async (
  db: D1Database,
  itemId: string,
): Promise<Result<Collection | undefined, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${COLLECTION_COLUMNS} FROM collections c
         JOIN collection_items i ON i.collection_id = c.id WHERE i.id = ?`,
      )
      .bind(itemId)
      .all();
    const [found] = await withItems(db, parseRows(CollectionRow, results));
    return found;
  });

/** An account's collections in the order they were made, as `featuredCollections` pages them. */
export const pageCollectionsByAge = async (
  db: D1Database,
  accountId: string,
  page: OffsetPage,
): Promise<Result<ReadonlyArray<Collection>, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${COLLECTION_COLUMNS} FROM collections c WHERE c.account_id = ?
         ORDER BY c.id LIMIT ? OFFSET ?`,
      )
      .bind(accountId, page.limit, page.offset)
      .all();
    return withItems(db, parseRows(CollectionRow, results));
  });

/** Collections by id, in no order; ids that name none are left out. */
export const findCollections = async (
  db: D1Database,
  ids: ReadonlyArray<string>,
): Promise<Result<ReadonlyArray<Collection>, RepositoryError>> =>
  ids.length === 0
    ? ok([])
    : runD1(async () => {
        const { results } = await db
          .prepare(`SELECT ${COLLECTION_COLUMNS} FROM collections c WHERE c.id ${sqlInJsonEach()}`)
          .bind(jsonStringArray(ids))
          .all();
        return withItems(db, parseRows(CollectionRow, results));
      });

/** The collection an item belongs to, by item id, for the items that still exist. */
export const findItemCollectionIds = async (
  db: D1Database,
  itemIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, string>, RepositoryError>> =>
  itemIds.length === 0
    ? ok(new Map())
    : runD1(async () => {
        const { results } = await db
          .prepare(`SELECT id, collection_id FROM collection_items WHERE id ${sqlInJsonEach()}`)
          .bind(jsonStringArray(itemIds))
          .all();
        const rows = parseRows(z.object({ id: z.string(), collection_id: z.string() }), results);
        return new Map(rows.map((row) => [row.id, row.collection_id]));
      });

export type OffsetPage = Readonly<{ offset: number; limit: number }>;

/**
 * An account's collections, newest first, as `Api::V1::CollectionsController`
 * pages them; only the discoverable ones unless `all`.
 */
export const listAccountCollections = async (
  db: D1Database,
  accountId: string,
  page: OffsetPage,
  all: boolean,
): Promise<Result<ReadonlyArray<Collection>, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${COLLECTION_COLUMNS} FROM collections c
         WHERE c.account_id = ?1 AND (?2 = 1 OR c.discoverable = 1)
         ORDER BY c.created_at DESC, c.id DESC LIMIT ?3 OFFSET ?4`,
      )
      .bind(accountId, all ? 1 : 0, page.limit, page.offset)
      .all();
    return withItems(db, parseRows(CollectionRow, results));
  });

/** Every collection of the account, discoverable or not (`@account.collections.size`). */
export const countAccountCollections = async (
  db: D1Database,
  accountId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare("SELECT COUNT(*) AS count FROM collections WHERE account_id = ?")
      .bind(accountId)
      .all();
    return parseRows(CountRow, results)[0]?.count ?? 0;
  });

/**
 * `Account#featured_in_collections`: the collections holding an item for the
 * account, whatever the item's state, in the order the items were made.
 */
export const listFeaturedInCollections = async (
  db: D1Database,
  accountId: string,
  page: OffsetPage,
): Promise<Result<ReadonlyArray<Collection>, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${COLLECTION_COLUMNS} FROM collection_items i
         JOIN collections c ON c.id = i.collection_id
         WHERE i.account_id = ?1 ORDER BY i.id LIMIT ?2 OFFSET ?3`,
      )
      .bind(accountId, page.limit, page.offset)
      .all();
    return withItems(db, parseRows(CollectionRow, results));
  });

export const countFeaturedInCollections = async (
  db: D1Database,
  accountId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare("SELECT COUNT(*) AS count FROM collection_items WHERE account_id = ?")
      .bind(accountId)
      .all();
    return parseRows(CountRow, results)[0]?.count ?? 0;
  });

/** The columns an item's account id fills: a local account, or a remote actor's URI. */
const accountColumns = (accountId: string): readonly [string | null, string | null] => {
  const actorUri = RemoteAccountId.decode(accountId);
  return actorUri.isOk() ? [null, actorUri.value] : [accountId, null];
};

const insertItemStatement = (
  db: D1Database,
  collectionId: string,
  item: Collection["items"][number],
): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO collection_items
         (id, collection_id, account_id, actor_uri, position, state, activity_uri, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      item.id,
      collectionId,
      ...accountColumns(item.accountId),
      item.position,
      item.state,
      item.activityUri ?? null,
      item.createdAt,
      item.createdAt,
    );

/** Store a new collection, its items and its topic tag, in one batch. */
export const insertCollection = async (
  db: D1Database,
  collection: Collection,
): Promise<Result<void, RepositoryError>> =>
  (
    await runD1Batch(db, [
      ...recordTagNames(db, collection.tagName === null ? [] : [collection.tagName]),
      db
        .prepare(
          `INSERT INTO collections
             (id, account_id, name, description, language, sensitive, discoverable, tag_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          collection.id,
          collection.accountId,
          collection.name,
          collection.description,
          collection.language,
          collection.sensitive ? 1 : 0,
          collection.discoverable ? 1 : 0,
          collection.tagName,
          collection.createdAt,
          collection.updatedAt,
        ),
      ...collection.items.map((item) => insertItemStatement(db, collection.id, item)),
    ])
  ).map(() => undefined);

/** Save a collection's own fields (not its items) and its topic tag. */
export const updateCollection = async (
  db: D1Database,
  collection: Collection,
): Promise<Result<void, RepositoryError>> =>
  (
    await runD1Batch(db, [
      ...recordTagNames(db, collection.tagName === null ? [] : [collection.tagName]),
      db
        .prepare(
          `UPDATE collections SET name = ?, description = ?, language = ?, sensitive = ?,
             discoverable = ?, tag_name = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(
          collection.name,
          collection.description,
          collection.language,
          collection.sensitive ? 1 : 0,
          collection.discoverable ? 1 : 0,
          collection.tagName,
          collection.updatedAt,
          collection.id,
        ),
    ])
  ).map(() => undefined);

export const deleteCollection = async (
  db: D1Database,
  id: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db.prepare("DELETE FROM collections WHERE id = ?").bind(id).run();
  });

export type InsertItemError = RepositoryError | Readonly<{ kind: "AlreadyFeatured" }>;

/**
 * Add an item after the collection's last one (`CollectionItem#set_position`).
 * An account the collection holds already is `AlreadyFeatured`.
 */
export const insertCollectionItem = async (
  db: D1Database,
  collectionId: string,
  item: Readonly<{
    id: string;
    accountId: string;
    state: CollectionItemState;
    createdAt: string;
    activityUri?: string | undefined;
  }>,
): Promise<Result<number, InsertItemError>> => {
  const [accountId, actorUri] = accountColumns(item.accountId);
  const written = await runD1(async () =>
    db
      .prepare(
        `INSERT INTO collection_items
           (id, collection_id, account_id, actor_uri, position, state, activity_uri, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, COALESCE(MAX(position), 0) + 1, ?5, ?6, ?7, ?7
         FROM collection_items WHERE collection_id = ?2
         ON CONFLICT DO NOTHING
         RETURNING position`,
      )
      .bind(
        item.id,
        collectionId,
        accountId,
        actorUri,
        item.state,
        item.activityUri ?? null,
        item.createdAt,
      )
      .all(),
  );
  if (written.isErr()) {
    return err(written.error);
  }
  const [row] = parseRows(z.object({ position: z.number() }), written.value.results);
  return row === undefined ? err({ kind: "AlreadyFeatured" }) : ok(row.position);
};

export const deleteCollectionItem = async (
  db: D1Database,
  itemId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db.prepare("DELETE FROM collection_items WHERE id = ?").bind(itemId).run();
  });

/** A topic named in a request: a stored tag, or the name a new one would take. */
export type TagLookup =
  | Readonly<{ kind: "Stored"; name: string; usable: boolean }>
  | Readonly<{ kind: "New"; name: string }>;

/** `Tag.matching_name`: the stored tag `raw` normalizes to. */
export const findTag = async (
  db: D1Database,
  raw: string,
): Promise<Result<TagLookup, RepositoryError>> => {
  const name = normalizeHashtag(raw);
  return runD1(async () => {
    const { results } = await db.prepare("SELECT usable FROM tags WHERE name = ?").bind(name).all();
    const [row] = parseRows(z.object({ usable: z.number() }), results);
    return row === undefined
      ? ({ kind: "New", name } as const)
      : ({ kind: "Stored", name, usable: row.usable !== 0 } as const);
  });
};

/** How a local owner and a remote account stand, as `feature_policy_for_account` reads it. */
export type RemoteStanding = Readonly<{
  ownerFollowsTarget: boolean;
  targetFollowsOwner: boolean;
  blockedEitherWay: boolean;
}>;

export const findRemoteStanding = async (
  db: D1Database,
  ownerId: string,
  actorUri: string,
): Promise<Result<RemoteStanding, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(
        `SELECT
           EXISTS (SELECT 1 FROM outbound_follows
                   WHERE account_id = ?1 AND actor_uri = ?2 AND state = 'Accepted') AS owner_follows,
           EXISTS (SELECT 1 FROM remote_follows
                   WHERE target_account_id = ?1 AND remote_actor_uri = ?2
                     AND follow_kind = 'Accepted') AS target_follows,
           EXISTS (SELECT 1 FROM blocks WHERE blocker_account_id = ?1 AND target_actor_uri = ?2)
           OR EXISTS (SELECT 1 FROM remote_blocks WHERE account_id = ?1 AND actor_uri = ?2)
             AS blocked`,
      )
      .bind(ownerId, actorUri)
      .all();
    const [standing] = parseRows(
      z.object({ owner_follows: z.number(), target_follows: z.number(), blocked: z.number() }),
      row.results,
    );
    return {
      ownerFollowsTarget: standing?.owner_follows === 1,
      targetFollowsOwner: standing?.target_follows === 1,
      blockedEitherWay: standing?.blocked === 1,
    };
  });

/** Of `accountIds`, the local accounts `viewerId` blocks (`Account#blocking`). */
export const blockedAccountIds = async (
  db: D1Database,
  viewerId: string,
  accountIds: ReadonlyArray<string>,
): Promise<Result<ReadonlySet<string>, RepositoryError>> =>
  accountIds.length === 0
    ? ok(new Set())
    : runD1(async () => {
        const { results } = await db
          .prepare(
            `SELECT target_account_id, target_actor_uri FROM blocks
             WHERE blocker_account_id = ?
               AND (target_account_id ${sqlInJsonEach()} OR target_actor_uri ${sqlInJsonEach()})`,
          )
          .bind(
            viewerId,
            jsonStringArray([...new Set(accountIds)]),
            jsonStringArray(accountIds.flatMap((id) => RemoteAccountId.decode(id).unwrapOr([]))),
          )
          .all();
        return new Set(
          parseRows(
            z.object({ target_account_id: z.string().nullable(), target_actor_uri: z.string() }),
            results,
          ).map((row) => row.target_account_id ?? RemoteAccountId.encode(row.target_actor_uri)),
        );
      });

/**
 * The local collection holding the item a remote actor's answer names: the
 * `FeatureRequest` it got (`activity`), or the authorization it gave
 * (`approval`), as `CollectionItem.local.find_by(…, account_id:)` finds it.
 */
export const findRemoteItem = async (
  db: D1Database,
  by: Readonly<{ column: "activity" | "approval"; uri: string; actorUri: string }>,
): Promise<
  Result<Readonly<{ collection: Collection; itemId: string }> | undefined, RepositoryError>
> =>
  runD1(async () => {
    const column = by.column === "activity" ? "activity_uri" : "approval_uri";
    const { results } = await db
      .prepare(
        `SELECT id, collection_id FROM collection_items WHERE ${column} = ? AND actor_uri = ?`,
      )
      .bind(by.uri, by.actorUri)
      .all();
    const [row] = parseRows(z.object({ id: z.string(), collection_id: z.string() }), results);
    if (row === undefined) {
      return undefined;
    }
    const { results: rows } = await db
      .prepare(`SELECT ${COLLECTION_COLUMNS} FROM collections c WHERE c.id = ?`)
      .bind(row.collection_id)
      .all();
    const [collection] = await withItems(db, parseRows(CollectionRow, rows));
    return collection && { collection, itemId: row.id };
  });

/** `update!(approval_uri:, state: :accepted)` of a remote account's item. */
export const acceptRemoteItem = async (
  db: D1Database,
  itemId: string,
  approvalUri: string,
  at: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        "UPDATE collection_items SET state = 'accepted', approval_uri = ?, updated_at = ? WHERE id = ?",
      )
      .bind(approvalUri, at, itemId)
      .run();
  });

/**
 * The inboxes of the remote accounts a local collection features, pending or
 * accepted (`CollectionReachFinder#collection_member_inboxes`).
 */
export const listCollectionMemberInboxes = async (
  db: D1Database,
  collectionId: string,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT COALESCE(a.shared_inbox_uri, a.inbox_uri) AS inbox FROM collection_items i
         JOIN remote_actors a ON a.actor_uri = i.actor_uri
         WHERE i.collection_id = ? AND i.state IN ('pending', 'accepted')`,
      )
      .bind(collectionId)
      .all();
    return parseRows(z.object({ inbox: z.string() }), results).map((row) => row.inbox);
  });

export const setCollectionItemState = async (
  db: D1Database,
  itemId: string,
  state: CollectionItemState,
  at: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare("UPDATE collection_items SET state = ?, updated_at = ? WHERE id = ?")
      .bind(state, at, itemId)
      .run();
  });
