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
  account_id: z.string(),
  position: z.number(),
  state: z.string(),
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
      `SELECT id, collection_id, account_id, position, state, created_at FROM collection_items
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
        accountId: item.account_id,
        position: item.position,
        state: item.state,
        createdAt: item.created_at,
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

const insertItemStatement = (
  db: D1Database,
  collectionId: string,
  item: Collection["items"][number],
): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO collection_items (id, collection_id, account_id, position, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      item.id,
      collectionId,
      item.accountId,
      item.position,
      item.state,
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
  item: Readonly<{ id: string; accountId: string; state: CollectionItemState; createdAt: string }>,
): Promise<Result<number, InsertItemError>> => {
  const written = await runD1(async () =>
    db
      .prepare(
        `INSERT INTO collection_items (id, collection_id, account_id, position, state, created_at, updated_at)
         SELECT ?1, ?2, ?3, COALESCE(MAX(position), 0) + 1, ?4, ?5, ?5
         FROM collection_items WHERE collection_id = ?2
         ON CONFLICT (collection_id, account_id) DO NOTHING
         RETURNING position`,
      )
      .bind(item.id, collectionId, item.accountId, item.state, item.createdAt)
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
            `SELECT target_account_id FROM blocks
             WHERE blocker_account_id = ? AND target_account_id ${sqlInJsonEach()}`,
          )
          .bind(viewerId, jsonStringArray([...new Set(accountIds)]))
          .all();
        return new Set(
          parseRows(z.object({ target_account_id: z.string() }), results).map(
            (row) => row.target_account_id,
          ),
        );
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
