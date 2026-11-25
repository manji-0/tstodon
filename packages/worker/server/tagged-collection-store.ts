import type { StatusTargetValue } from "@tstodon/domain";
import { ok, type Result } from "neverthrow";
import { z } from "zod";
import {
  jsonStringArray,
  parseRows,
  type RepositoryError,
  runD1,
  runD1Batch,
  sqlInJsonEach,
} from "./d1";

/** A collection a status tags: a local one, or a stored remote one. */
export type TaggedCollectionRef = Readonly<{
  kind: "LocalCollection" | "RemoteCollection";
  id: string;
}>;

/** The tables of the statuses of each kind, and of the collections they tag. */
const TABLES = {
  LocalStatus: { tagged: "status_tagged_collections", statuses: "statuses" },
  RemoteStatus: { tagged: "remote_status_tagged_collections", statuses: "remote_statuses" },
} as const satisfies Record<StatusTargetValue["kind"], { tagged: string; statuses: string }>;

const RefRow = z.object({
  kind: z.literal(["LocalCollection", "RemoteCollection"]),
  id: z.string(),
  uri: z.string().nullable(),
});

/**
 * The stored collections of `localIds` (this server's, by id) and of
 * `remoteUris` (by `uri`), as `TagManager#uri_to_resource` finds them, in
 * one statement. Local ones are keyed by id, remote ones by URI.
 */
export const findKnownCollections = async (
  db: D1Database,
  localIds: ReadonlyArray<string>,
  remoteUris: ReadonlyArray<string>,
): Promise<
  Result<
    Readonly<{
      local: ReadonlyMap<string, TaggedCollectionRef>;
      remote: ReadonlyMap<string, TaggedCollectionRef>;
    }>,
    RepositoryError
  >
> =>
  localIds.length === 0 && remoteUris.length === 0
    ? ok({ local: new Map(), remote: new Map() })
    : runD1(async () => {
        const { results } = await db
          .prepare(
            `SELECT 'LocalCollection' AS kind, id, NULL AS uri FROM collections
             WHERE id ${sqlInJsonEach()}
             UNION ALL
             SELECT 'RemoteCollection' AS kind, id, uri FROM remote_collections
             WHERE uri ${sqlInJsonEach()}`,
          )
          .bind(jsonStringArray(localIds), jsonStringArray(remoteUris))
          .all();
        const rows = parseRows(RefRow, results);
        return {
          local: new Map(
            rows.flatMap((row) =>
              row.kind === "LocalCollection" ? [[row.id, { kind: row.kind, id: row.id }]] : [],
            ),
          ),
          remote: new Map(
            rows.flatMap((row) =>
              row.kind === "RemoteCollection" && row.uri !== null
                ? [[row.uri, { kind: row.kind, id: row.id }]]
                : [],
            ),
          ),
        };
      });

/**
 * Tag each of `refs` on `status`, in order, once: a status or a collection
 * that is gone is skipped.
 */
const insertStatement = (
  db: D1Database,
  status: StatusTargetValue,
  refs: ReadonlyArray<TaggedCollectionRef>,
): D1PreparedStatement => {
  const { tagged, statuses } = TABLES[status.kind];
  return db
    .prepare(
      `INSERT OR IGNORE INTO ${tagged} (status_id, collection_id, remote_collection_id)
       SELECT ?1, c.id, r.id
       FROM json_each(?2) AS j
       LEFT JOIN collections c
         ON json_extract(j.value, '$.kind') = 'LocalCollection' AND c.id = json_extract(j.value, '$.id')
       LEFT JOIN remote_collections r
         ON json_extract(j.value, '$.kind') = 'RemoteCollection' AND r.id = json_extract(j.value, '$.id')
       WHERE (c.id IS NOT NULL OR r.id IS NOT NULL)
         AND EXISTS (SELECT 1 FROM ${statuses} WHERE id = ?1)
       ORDER BY j.key`,
    )
    .bind(status.statusId, JSON.stringify(refs));
};

/**
 * The collections `status` tags become `refs`: the ones it no longer tags
 * are dropped, the new ones added after those it keeps, as
 * `ProcessLinksService` and `update_tagged_objects!` leave them.
 */
export const replaceTaggedCollections = async (
  db: D1Database,
  status: StatusTargetValue,
  refs: ReadonlyArray<TaggedCollectionRef>,
): Promise<Result<void, RepositoryError>> => {
  const { tagged } = TABLES[status.kind];
  const idsOf = (kind: TaggedCollectionRef["kind"]) =>
    jsonStringArray(refs.flatMap((ref) => (ref.kind === kind ? [ref.id] : [])));
  return (
    await runD1Batch(db, [
      db
        .prepare(
          `DELETE FROM ${tagged} WHERE status_id = ?
             AND (collection_id IS NULL OR collection_id NOT ${sqlInJsonEach()})
             AND (remote_collection_id IS NULL OR remote_collection_id NOT ${sqlInJsonEach()})`,
        )
        .bind(status.statusId, idsOf("LocalCollection"), idsOf("RemoteCollection")),
      ...(refs.length === 0 ? [] : [insertStatement(db, status, refs)]),
    ])
  ).map(() => undefined);
};

/** Tag `ref` on `status`, after what it tags (`TaggedCollectionResolveWorker`). */
export const addTaggedCollection = async (
  db: D1Database,
  status: StatusTargetValue,
  ref: TaggedCollectionRef,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await insertStatement(db, status, [ref]).run();
  });

/**
 * Of `domains`, those of known remote accounts that no domain block names
 * (`Instance.searchable`), in one statement.
 */
export const searchableDomains = async (
  db: D1Database,
  domains: ReadonlyArray<string>,
): Promise<Result<ReadonlySet<string>, RepositoryError>> =>
  domains.length === 0
    ? ok(new Set())
    : runD1(async () => {
        const { results } = await db
          .prepare(
            `SELECT DISTINCT domain FROM remote_actors
             WHERE domain ${sqlInJsonEach()}
               AND domain NOT IN (SELECT domain FROM domain_blocks)`,
          )
          .bind(jsonStringArray([...new Set(domains)]))
          .all();
        return new Set(
          parseRows(z.object({ domain: z.string() }), results).map((row) => row.domain),
        );
      });

const TaggedRow = z.object({
  status_kind: z.literal(["LocalStatus", "RemoteStatus"]),
  status_id: z.string(),
  collection_id: z.string().nullable(),
  remote_collection_id: z.string().nullable(),
});

/**
 * The tags of the local statuses (`?1`, a JSON array of ids) and the remote
 * ones (`?2`): a key seek per status in each table.
 */
export const TAGGED_COLLECTIONS_SQL = `SELECT 'LocalStatus' AS status_kind, status_id, collection_id,
    remote_collection_id, rowid AS position
  FROM status_tagged_collections WHERE status_id ${sqlInJsonEach()}
  UNION ALL
  SELECT 'RemoteStatus' AS status_kind, status_id, collection_id, remote_collection_id,
    rowid AS position
  FROM remote_status_tagged_collections WHERE status_id ${sqlInJsonEach()}
  ORDER BY position`;

/** A status's key in {@link listTaggedCollections}. */
export const taggedKey = (status: StatusTargetValue): string => `${status.kind}:${status.statusId}`;

/**
 * The collections each of `statuses` tags, in the order they were tagged,
 * keyed by {@link taggedKey}: one statement for them all.
 */
export const listTaggedCollections = async (
  db: D1Database,
  statuses: ReadonlyArray<StatusTargetValue>,
): Promise<Result<ReadonlyMap<string, ReadonlyArray<TaggedCollectionRef>>, RepositoryError>> => {
  const idsOf = (kind: StatusTargetValue["kind"]) =>
    jsonStringArray([
      ...new Set(statuses.flatMap((status) => (status.kind === kind ? [status.statusId] : []))),
    ]);
  return statuses.length === 0
    ? ok(new Map())
    : runD1(async () => {
        const { results } = await db
          .prepare(TAGGED_COLLECTIONS_SQL)
          .bind(idsOf("LocalStatus"), idsOf("RemoteStatus"))
          .all();
        const tagged = new Map<string, TaggedCollectionRef[]>();
        for (const row of parseRows(TaggedRow, results)) {
          const key = `${row.status_kind}:${row.status_id}`;
          const ref: TaggedCollectionRef =
            row.collection_id === null
              ? { kind: "RemoteCollection", id: row.remote_collection_id ?? "" }
              : { kind: "LocalCollection", id: row.collection_id };
          tagged.set(key, [...(tagged.get(key) ?? []), ref]);
        }
        return tagged;
      });
};
