import { type CollectionItemState, RemoteCollection } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, parseRows, type RepositoryError, runD1, sqlInJsonEach } from "./d1";
import { newEntityId } from "./ids";
import { RemoteAccountId } from "./remote-account-id";

const CollectionRow = z.object({
  id: z.string(),
  actor_uri: z.string(),
  uri: z.string(),
  url: z.string(),
  name: z.string(),
  description_html: z.string(),
  language: z.string().nullable(),
  sensitive: z.number(),
  discoverable: z.number(),
  original_number_of_items: z.number(),
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
  object_uri: z.string().nullable(),
  uri: z.string().nullable(),
  position: z.number(),
  state: z.string(),
  activity_uri: z.string().nullable(),
  approval_uri: z.string().nullable(),
  created_at: z.string(),
});
export type RemoteItemRow = z.infer<typeof ItemRow>;

const COLUMNS =
  "c.id, c.actor_uri, c.uri, c.url, c.name, c.description_html, c.language, c.sensitive, c.discoverable, c.original_number_of_items, c.tag_name, c.created_at, c.updated_at";
const ITEM_COLUMNS =
  "id, collection_id, account_id, actor_uri, object_uri, uri, position, state, activity_uri, approval_uri, created_at";

/** The collections with the items whose account is known, in `position` order. */
const withItems = async (
  db: D1Database,
  rows: ReadonlyArray<CollectionRow>,
): Promise<RemoteCollection[]> => {
  if (rows.length === 0) {
    return [];
  }
  const { results } = await db
    .prepare(
      `SELECT ${ITEM_COLUMNS} FROM remote_collection_items
       WHERE collection_id ${sqlInJsonEach()} AND (account_id IS NOT NULL OR actor_uri IS NOT NULL)
       ORDER BY position, id`,
    )
    .bind(jsonStringArray(rows.map((row) => row.id)))
    .all();
  const items = new Map<string, RemoteItemRow[]>();
  for (const item of parseRows(ItemRow, results)) {
    items.set(item.collection_id, [...(items.get(item.collection_id) ?? []), item]);
  }
  return rows.flatMap((row) => {
    const parsed = RemoteCollection.parse({
      kind: "RemoteCollection",
      id: row.id,
      accountId: RemoteAccountId.encode(row.actor_uri),
      actorUri: row.actor_uri,
      uri: row.uri,
      url: row.url,
      name: row.name,
      descriptionHtml: row.description_html,
      language: row.language,
      sensitive: row.sensitive !== 0,
      discoverable: row.discoverable !== 0,
      originalNumberOfItems: row.original_number_of_items,
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
        ...(item.uri === null ? {} : { uri: item.uri }),
      })),
    });
    return parsed.isOk() ? [parsed.value] : [];
  });
};

const select = async (
  db: D1Database,
  where: string,
  binds: ReadonlyArray<unknown>,
  tail = "",
): Promise<RemoteCollection[]> => {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM remote_collections c WHERE ${where} ${tail}`)
    .bind(...binds)
    .all();
  return withItems(db, parseRows(CollectionRow, results));
};

export const findRemoteCollection = async (
  db: D1Database,
  id: string,
): Promise<Result<RemoteCollection | undefined, RepositoryError>> =>
  runD1(async () => (await select(db, "c.id = ?", [id]))[0]);

export const findRemoteCollectionByUri = async (
  db: D1Database,
  uri: string,
): Promise<Result<RemoteCollection | undefined, RepositoryError>> =>
  runD1(async () => (await select(db, "c.uri = ?", [uri]))[0]);

export const findRemoteCollections = async (
  db: D1Database,
  ids: ReadonlyArray<string>,
): Promise<Result<ReadonlyArray<RemoteCollection>, RepositoryError>> =>
  ids.length === 0
    ? ok([])
    : runD1(() => select(db, `c.id ${sqlInJsonEach()}`, [jsonStringArray(ids)]));

/** The remote collection each item belongs to, by item id, for the items that still exist. */
export const findRemoteItemCollectionIds = async (
  db: D1Database,
  itemIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, string>, RepositoryError>> =>
  itemIds.length === 0
    ? ok(new Map())
    : runD1(async () => {
        const { results } = await db
          .prepare(
            `SELECT id, collection_id FROM remote_collection_items WHERE id ${sqlInJsonEach()}`,
          )
          .bind(jsonStringArray(itemIds))
          .all();
        const rows = parseRows(z.object({ id: z.string(), collection_id: z.string() }), results);
        return new Map(rows.map((row) => [row.id, row.collection_id]));
      });

/** A remote account's collections, newest first; only the discoverable ones unless `all`. */
export const listRemoteCollectionsOf = async (
  db: D1Database,
  actorUri: string,
  page: Readonly<{ offset: number; limit: number }>,
  all: boolean,
): Promise<Result<ReadonlyArray<RemoteCollection>, RepositoryError>> =>
  runD1(() =>
    select(
      db,
      "c.actor_uri = ? AND (? = 1 OR c.discoverable = 1)",
      [actorUri, all ? 1 : 0, page.limit, page.offset],
      "ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?",
    ),
  );

export const countRemoteCollectionsOf = async (
  db: D1Database,
  actorUri: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare("SELECT COUNT(*) AS count FROM remote_collections WHERE actor_uri = ?")
      .bind(actorUri)
      .all();
    return parseRows(z.object({ count: z.number() }), results)[0]?.count ?? 0;
  });

/** The remote collections a local account is in, whatever the item's state. */
export const listRemoteCollectionsFeaturing = async (
  db: D1Database,
  accountId: string,
): Promise<Result<ReadonlyArray<RemoteCollection>, RepositoryError>> =>
  runD1(() =>
    select(
      db,
      "c.id IN (SELECT collection_id FROM remote_collection_items WHERE account_id = ?)",
      [accountId],
      "ORDER BY c.id",
    ),
  );

/** The fields `ProcessFeaturedCollectionService#collection_attributes` sets. */
export type RemoteCollectionFields = Readonly<{
  actorUri: string;
  uri: string;
  url: string;
  name: string;
  descriptionHtml: string;
  language: string | null;
  sensitive: boolean;
  discoverable: boolean;
  originalNumberOfItems: number;
  tagName: string | null;
}>;

/**
 * `find_or_initialize_by(uri:)` and `update!`: the collection's id, and the
 * collection as it was (none when it is new).
 */
export const upsertRemoteCollection = async (
  db: D1Database,
  fields: RemoteCollectionFields,
  at: string,
): Promise<
  Result<Readonly<{ id: string; before: RemoteCollection | undefined }>, RepositoryError>
> => {
  const before = await findRemoteCollectionByUri(db, fields.uri);
  if (before.isErr()) {
    return err(before.error);
  }
  const id = before.value?.id ?? newEntityId();
  const written = await runD1(() =>
    db
      .prepare(
        `INSERT INTO remote_collections
           (id, actor_uri, uri, url, name, description_html, language, sensitive, discoverable,
            original_number_of_items, tag_name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
         ON CONFLICT (uri) DO UPDATE SET url = ?4, name = ?5, description_html = ?6, language = ?7,
           sensitive = ?8, discoverable = ?9, original_number_of_items = ?10, tag_name = ?11,
           updated_at = ?12`,
      )
      .bind(
        id,
        fields.actorUri,
        fields.uri,
        fields.url,
        fields.name,
        fields.descriptionHtml,
        fields.language,
        fields.sensitive ? 1 : 0,
        fields.discoverable ? 1 : 0,
        fields.originalNumberOfItems,
        fields.tagName,
        at,
      )
      .run(),
  );
  return written.map(() => ({ id, before: before.value }));
};

/**
 * `collection_items.where.not(uri: item_uris).delete_all`. An item with no
 * uri, a local account's accepted `FeatureRequest` the owner's item will
 * name, stays while the list names any item (`NOT IN` is not true for NULL),
 * and goes when it names none, as Rails writes an empty list `NOT (1=0)`.
 */
export const deleteRemoteItemsExcept = async (
  db: D1Database,
  collectionId: string,
  uris: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `DELETE FROM remote_collection_items
         WHERE collection_id = ? AND uri NOT IN (SELECT value FROM json_each(?))`,
      )
      .bind(collectionId, jsonStringArray(uris))
      .run();
  });

/** `Remove` from `featuredCollections`: the actor's collection goes. */
export const deleteRemoteCollection = async (
  db: D1Database,
  actorUri: string,
  uri: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare("DELETE FROM remote_collections WHERE actor_uri = ? AND uri = ?")
      .bind(actorUri, uri)
      .run();
  });

/** `Remove` of an item from a collection, by the item's id. */
export const deleteRemoteItemByUri = async (
  db: D1Database,
  collectionId: string,
  uri: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare("DELETE FROM remote_collection_items WHERE collection_id = ? AND uri = ?")
      .bind(collectionId, uri)
      .run();
  });

/** The rows of a collection's items, any account or none, for processing. */
export const listRemoteItemRows = async (
  db: D1Database,
  collectionId: string,
): Promise<Result<ReadonlyArray<RemoteItemRow>, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM remote_collection_items WHERE collection_id = ?`)
      .bind(collectionId)
      .all();
    return parseRows(ItemRow, results);
  });

/** One item's row, with the uri of its collection, for `VerifyFeaturedItemService`. */
export const findRemoteItemRow = async (
  db: D1Database,
  itemId: string,
): Promise<
  Result<Readonly<{ item: RemoteItemRow; collectionUri: string }> | undefined, RepositoryError>
> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT i.*, c.uri AS collection_uri
         FROM remote_collection_items i JOIN remote_collections c ON c.id = i.collection_id
         WHERE i.id = ?`,
      )
      .bind(itemId)
      .all();
    const [row] = parseRows(ItemRow.extend({ collection_uri: z.string() }), results);
    return row === undefined ? undefined : { item: row, collectionUri: row.collection_uri };
  });

/**
 * `VerifyFeaturedItemService`'s `update!(account:, approval_uri:, state:
 * :accepted)`: the item is the verified account's. Nothing changes when that
 * account is in the collection already, or the authorization names another
 * item, as Mastodon's unique indexes refuse the update.
 */
export const acceptRemoteItem = async (
  db: D1Database,
  itemId: string,
  account: Readonly<{ accountId: string | null; actorUri: string | null }>,
  approvalUri: string,
  at: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `UPDATE OR IGNORE remote_collection_items
         SET account_id = ?, actor_uri = ?, approval_uri = ?, state = 'accepted', updated_at = ?
         WHERE id = ?`,
      )
      .bind(account.accountId, account.actorUri, approvalUri, at, itemId)
      .run();
  });

/** What `ProcessFeaturedItemService` writes of an item. */
export type RemoteItemWrite = Readonly<{
  id: string;
  collectionId: string;
  uri: string;
  objectUri: string;
  position: number;
  createdAt: string;
  state: CollectionItemState;
  accountId: string | null;
  actorUri: string | null;
  activityUri: string | null;
  approvalUri: string | null;
}>;

export const saveRemoteItem = async (
  db: D1Database,
  item: RemoteItemWrite,
  at: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `INSERT INTO remote_collection_items
           (id, collection_id, account_id, actor_uri, object_uri, uri, position, state,
            activity_uri, approval_uri, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT (id) DO UPDATE SET account_id = ?3, actor_uri = ?4, object_uri = ?5, uri = ?6,
           position = ?7, state = ?8, approval_uri = ?10, updated_at = ?12`,
      )
      .bind(
        item.id,
        item.collectionId,
        item.accountId,
        item.actorUri,
        item.objectUri,
        item.uri,
        item.position,
        item.state,
        item.activityUri,
        item.approvalUri,
        item.createdAt,
        at,
      )
      .run();
  });

/**
 * `FeatureRequest#accept_request!`: a local account accepted into a remote
 * collection, after its last item. None when the account is in the
 * collection already, whatever the state of its item: Mastodon's `create!`
 * raises on the unique `(account_id, collection_id)`.
 */
export const insertAcceptedLocalItem = async (
  db: D1Database,
  collectionId: string,
  accountId: string,
  activityUri: string,
  at: string,
): Promise<Result<string | undefined, RepositoryError>> => {
  const id = newEntityId();
  const written = await runD1(() =>
    db
      .prepare(
        `INSERT INTO remote_collection_items
           (id, collection_id, account_id, position, state, activity_uri, created_at, updated_at)
         SELECT ?1, ?2, ?3, COALESCE(MAX(position), 0) + 1, 'accepted', ?4, ?5, ?5
         FROM remote_collection_items WHERE collection_id = ?2
         ON CONFLICT DO NOTHING`,
      )
      .bind(id, collectionId, accountId, activityUri, at)
      .run(),
  );
  return written.map((result) => ((result.meta.changes ?? 0) > 0 ? id : undefined));
};

/** The remote collection holding the item `itemId`. */
export const findRemoteCollectionOfItem = async (
  db: D1Database,
  itemId: string,
): Promise<Result<RemoteCollection | undefined, RepositoryError>> =>
  runD1(
    async () =>
      (
        await select(
          db,
          "c.id = (SELECT collection_id FROM remote_collection_items WHERE id = ?)",
          [itemId],
        )
      )[0],
  );

export const setRemoteItemState = async (
  db: D1Database,
  itemId: string,
  state: CollectionItemState,
  at: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare("UPDATE remote_collection_items SET state = ?, updated_at = ? WHERE id = ?")
      .bind(state, at, itemId)
      .run();
  });
