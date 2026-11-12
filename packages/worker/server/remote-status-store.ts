import {
  IsoInstant,
  type RemoteAttachment,
  RemoteAttachmentSchema,
  type RemoteEmoji,
  RemoteEmojiSchema,
  RemotePoll,
  QuoteInteractionPolicy,
  RemoteStatus,
  type RemovedRemoteStatus,
  StatusId,
  Visibility,
} from "@tstodon/domain";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { rerollEntityId } from "./ids";
import {
  jsonStringArray,
  okValues,
  parseRows,
  type RepositoryError,
  runD1,
  runD1Batch,
  type StoredRowInvalid,
  storedRowError,
} from "./d1";
import { removedBoostsFromRows } from "./removed-boost";
import { parseJsonColumn, parseJsonText } from "./json-column";
import { visibilitySql } from "./sql-enums";
import { htmlHashtags, recordTagNames, searchableTagNames } from "./hashtags";
import {
  claimRemoteStatusThreadBackfill as claimRemoteStatusThreadBackfillSql,
  releaseRemoteStatusThreadBackfill as releaseRemoteStatusThreadBackfillSql,
  findRemoteStatusThreadRefresh as findRemoteStatusThreadRefreshSql,
  finishRemoteStatusThreadBackfill as finishRemoteStatusThreadBackfillSql,
  deleteRemoteStatusByObjectUri as deleteRemoteStatusByObjectUriSql,
  findRemoteStatusById as findRemoteStatusByIdSql,
  findRemoteStatusByObjectUri as findRemoteStatusByObjectUriSql,
  findRemoteStatusesByIds as findRemoteStatusesByIdsSql,
  findRemoteStatusRefsByObjectUris as findRemoteStatusRefsByObjectUrisSql,
  listLocalBoostsOfRemoteObject as listLocalBoostsOfRemoteObjectSql,
  deleteUnindexedRemoteStatusTags as deleteUnindexedRemoteStatusTagsSql,
  insertUnindexedRemoteStatusTags as insertUnindexedRemoteStatusTagsSql,
  insertUnindexedRemoteTagNames as insertUnindexedRemoteTagNamesSql,
  listRemoteStatusTags as listRemoteStatusTagsSql,
  markRemoteStatusesTagsIndexed as markRemoteStatusesTagsIndexedSql,
  listUnindexedRemoteStatuses as listUnindexedRemoteStatusesSql,
  markRemoteStatusTagsIndexed as markRemoteStatusTagsIndexedSql,
  refuseReplacedRemoteStatus as refuseReplacedRemoteStatusSql,
  upsertRemoteStatus as upsertRemoteStatusSql,
} from "./generated/prisma/sql";
import { settleRemotePollVotesStatement } from "./remote-poll-vote-store";
import { d1PrepareTyped, queryTyped, runTyped, type TypedSqlLike } from "./typed-sql";

const IdRow = z.object({ id: z.string() });
const VisibilityRow = z.object({ visibility: z.string() });
const IdObjectUriActorUriRow = z.object({
  id: z.string(),
  object_uri: z.string(),
  actor_uri: z.string(),
});
const UnindexedRemoteStatusRow = z.object({
  id: z.string(),
  content_html: z.string(),
  visibility: z.string(),
});

export const RemoteStatusRowSchema = z.object({
  id: z.string().min(1),
  actor_uri: z.string().min(1),
  object_uri: z.string().min(1),
  url: z.string().nullable(),
  content_html: z.string(),
  spoiler_text: z.string(),
  visibility: z.string().min(1),
  sensitive: z.number(),
  language: z.string().nullable(),
  published_at: z.string().min(1),
  edited_at: z.string().nullable(),
  media_json: z.string(),
  card_json: z.string().nullable(),
  poll_json: z.string().nullable(),
  emojis_json: z.string(),
  quote_policy_json: z.string().nullable(),
});

export type RemoteStatusRow = z.infer<typeof RemoteStatusRowSchema>;

export const parseRemoteStatusRow = schemaResult(RemoteStatusRowSchema);

const mediaFromJson = (raw: string): ReadonlyArray<RemoteAttachment> => {
  const parsed = schemaResult(z.array(RemoteAttachmentSchema))(parseJsonText(raw).unwrapOr([]));
  return parsed.isOk() ? parsed.value : [];
};

const emojisFromJson = (raw: string): ReadonlyArray<RemoteEmoji> => {
  const parsed = schemaResult(z.array(RemoteEmojiSchema))(parseJsonText(raw).unwrapOr([]));
  return parsed.isOk() ? parsed.value : [];
};

/** A missing or unreadable poll column reads as no poll; the note itself still shows. */
const pollFromJson = (raw: string | null): RemotePoll => {
  if (raw === null) {
    return RemotePoll.none;
  }
  const parsed = RemotePoll.parse(parseJsonText(raw).unwrapOr(null));
  return parsed.isOk() ? parsed.value : RemotePoll.none;
};

/** A missing or unreadable policy column reads as no policy: only the author may quote. */
const quotePolicyFromJson = (raw: string | null): QuoteInteractionPolicy =>
  raw === null
    ? QuoteInteractionPolicy.none
    : parseJsonColumn(QuoteInteractionPolicy.schema, raw).unwrapOr(QuoteInteractionPolicy.none);

/** A stored remote status row that does not read as a status, and the author it names. */
export type InvalidRemoteStatusRow = StoredRowInvalid & Readonly<{ actorUri: string }>;

export const remoteStatusFromRow = (
  row: RemoteStatusRow,
): Result<RemoteStatus, InvalidRemoteStatusRow> => {
  const invalid: InvalidRemoteStatusRow = {
    kind: "StoredRowInvalid",
    id: row.id,
    actorUri: row.actor_uri,
  };
  const id = StatusId.parse(row.id);
  const publishedAt = IsoInstant.parse(row.published_at);
  const editedAt = IsoInstant.parse(row.edited_at ?? "").unwrapOr(undefined);
  const visibility = Visibility.fromMastodon(row.visibility);
  if (id.isErr() || publishedAt.isErr() || (row.edited_at && !editedAt) || visibility.isErr()) {
    return err(invalid);
  }
  return RemoteStatus.fromFetched({
    id: id.value,
    actorUri: row.actor_uri,
    objectUri: row.object_uri,
    contentHtml: row.content_html,
    spoilerText: row.spoiler_text,
    visibility: visibility.value,
    sensitive: row.sensitive === 1,
    language:
      row.language && row.language.length > 0
        ? { kind: "Present", value: row.language }
        : { kind: "None" },
    publishedAt: publishedAt.value,
    editedAt,
    media: mediaFromJson(row.media_json),
    poll: pollFromJson(row.poll_json),
    emojis: emojisFromJson(row.emojis_json),
    quotePolicy: quotePolicyFromJson(row.quote_policy_json),
    ...(row.url ? { url: row.url } : {}),
  }).mapErr(() => invalid);
};

const InvalidRowRef = z.object({ id: z.string(), actor_uri: z.string() });

/**
 * The status a stored row holds, as D1 returned it. A row whose shape does
 * not parse (an empty `published_at`, a `sensitive` that is no number) is
 * invalid as one whose values do not read: both are there, and neither is a
 * status.
 */
const storedRemoteStatus = (raw: unknown): Result<RemoteStatus, InvalidRemoteStatusRow> => {
  const row = parseRemoteStatusRow(raw);
  if (row.isOk()) {
    return remoteStatusFromRow(row.value);
  }
  const ref = schemaResult(InvalidRowRef)(raw);
  return err({
    kind: "StoredRowInvalid",
    id: ref.isOk() ? ref.value.id : "",
    actorUri: ref.isOk() ? ref.value.actor_uri : "",
  });
};

/** What a read of one stored remote status gives: the status, none, or a row that is no status. */
export type RemoteStatusRead = Result<
  RemoteStatus | undefined,
  RepositoryError | InvalidRemoteStatusRow
>;

/** The first row of a query for one remote status, unparsed, or `undefined` for none. */
const findRow = (db: D1Database, typed: TypedSqlLike): Promise<Result<unknown, RepositoryError>> =>
  runD1(async () => (await queryTyped(db, typed, z.unknown()))[0]);

const readRemoteStatus = (queried: Result<unknown, RepositoryError>): RemoteStatusRead => {
  if (queried.isErr()) {
    return err(queried.error);
  }
  return queried.value === undefined ? ok(undefined) : storedRemoteStatus(queried.value);
};

/**
 * The read of a caller that goes on without a row that does not read: the
 * row is logged and counts as none, where a failed read stays an error. An
 * inbox activity that refers to such a row is settled this way, as its
 * redelivery would find the same row.
 */
export const readableRemoteStatus = (
  read: RemoteStatusRead,
): Result<RemoteStatus | undefined, RepositoryError> => {
  if (read.isOk()) {
    return ok(read.value);
  }
  if (read.error.kind === "RepositoryError") {
    return err(read.error);
  }
  console.warn(JSON.stringify({ kind: "InvalidRemoteStatusRowSkipped", statusId: read.error.id }));
  return ok(undefined);
};

/** {@link findDeliveredRemoteStatus}, by id. */
export const findDeliveredRemoteStatusById = async (
  db: D1Database,
  id: string,
): Promise<RemoteStatusRead> => readRemoteStatus(await findRow(db, findRemoteStatusByIdSql(id)));

export const findRemoteStatusById = async (
  db: D1Database,
  id: string,
): Promise<Result<RemoteStatus | undefined, RepositoryError>> =>
  (await findDeliveredRemoteStatusById(db, id)).mapErr(storedRowError);

/**
 * Claim fetching the status's thread unless one was claimed within `ttlMs`.
 * Resolves to the claim's timestamp, or undefined when another holds it.
 */
export const claimRemoteThreadBackfill = async (
  db: D1Database,
  statusId: string,
  ttlMs: number,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const now = Date.now();
    const claimedAt = new Date(now).toISOString();
    const rows = await queryTyped(
      db,
      claimRemoteStatusThreadBackfillSql(claimedAt, statusId, new Date(now - ttlMs).toISOString()),
      IdRow,
    );
    return rows.length > 0 ? claimedAt : undefined;
  });

/** Give up a claim whose job could not be queued, so the next view tries again. */
export const releaseRemoteThreadBackfill = async (
  db: D1Database,
  statusId: string,
  claimedAt: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, releaseRemoteStatusThreadBackfillSql(statusId, claimedAt));
  });

const ThreadRefreshRow = z.object({
  context_fetched_at: z.string().nullable(),
  context_refreshed_at: z.string().nullable(),
  context_refresh_count: z.number().nullable(),
});

/** The status's latest thread fetch: its claim, and the claim and count it finished with. */
export type ThreadRefreshRecord = Readonly<{
  claimedAt: string | null;
  finishedClaim: string | null;
  resultCount: number | null;
}>;

/** The thread fetch record of a stored remote status, or undefined when there is none. */
export const findRemoteThreadRefresh = async (
  db: D1Database,
  statusId: string,
): Promise<Result<ThreadRefreshRecord | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findRemoteStatusThreadRefreshSql(statusId), ThreadRefreshRow);
    const row = rows[0];
    return row
      ? {
          claimedAt: row.context_fetched_at,
          finishedClaim: row.context_refreshed_at,
          resultCount: row.context_refresh_count,
        }
      : undefined;
  });

/** Close the status's current thread fetch claim, with the statuses it stored. */
export const finishRemoteThreadBackfill = async (
  db: D1Database,
  statusId: string,
  resultCount: number,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, finishRemoteStatusThreadBackfillSql(statusId, resultCount));
  });

/** Stored remote statuses keyed by id; unknown or unreadable rows are left out. */
export const findRemoteStatusesByIds = async (
  db: D1Database,
  ids: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, RemoteStatus>, RepositoryError>> => {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  if (unique.length === 0) {
    return ok(new Map<string, RemoteStatus>());
  }
  const queried = await runD1(async () =>
    queryTyped(db, findRemoteStatusesByIdsSql(jsonStringArray(unique)), RemoteStatusRowSchema),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(
    new Map(
      okValues(queried.value.map((row) => remoteStatusFromRow(row))).map((status) => [
        status.id,
        status,
      ]),
    ),
  );
};

/**
 * The status stored at an object URI, for a caller that tells a row that
 * does not read as a status from a failed read: an inbox activity settles
 * the first (it replaces the row, or goes on without it), where a failed
 * read is retried.
 */
export const findDeliveredRemoteStatus = async (
  db: D1Database,
  objectUri: string,
): Promise<RemoteStatusRead> =>
  readRemoteStatus(await findRow(db, findRemoteStatusByObjectUriSql(objectUri)));

export const findRemoteStatusByObjectUri = async (
  db: D1Database,
  objectUri: string,
): Promise<Result<RemoteStatus | undefined, RepositoryError>> =>
  (await findDeliveredRemoteStatus(db, objectUri)).mapErr(storedRowError);

const StatusTagRow = z.object({ status_id: z.string(), tag: z.string() });

/** The tag names of the given remote statuses in stored order, keyed by status id. */
export const listRemoteStatusTags = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, ReadonlyArray<string>>, RepositoryError>> => {
  const unique = [...new Set(statusIds.filter((id) => id.length > 0))];
  if (unique.length === 0) {
    return ok(new Map());
  }
  const queried = await runD1(async () =>
    queryTyped(db, listRemoteStatusTagsSql(jsonStringArray(unique)), StatusTagRow),
  );
  return queried
    .map((rows) => Map.groupBy(rows, (row) => row.status_id))
    .map((groups) => new Map([...groups].map(([id, rows]) => [id, rows.map((row) => row.tag)])));
};

/**
 * The statements that replace a remote status's indexed tags with `tags`,
 * store their names for hashtag search when its visibility lets anyone read
 * them, and mark the row as indexed so the backfill job skips it. Four
 * statements at most, however many tags.
 */
const remoteStatusTagStatements = (
  db: D1Database,
  statusId: string,
  visibility: Visibility,
  tags: ReadonlyArray<string>,
): D1PreparedStatement[] => [
  db.prepare("DELETE FROM remote_status_tags WHERE status_id = ?").bind(statusId),
  ...(tags.length === 0
    ? []
    : [
        db
          .prepare(
            `INSERT OR IGNORE INTO remote_status_tags (status_id, tag)
             SELECT ?, value FROM json_each(?) ORDER BY key`,
          )
          .bind(statusId, jsonStringArray(tags)),
      ]),
  d1PrepareTyped(db, markRemoteStatusTagsIndexedSql(statusId)),
  ...recordTagNames(db, searchableTagNames(visibility, tags)),
];

/** The statement that inserts a remote status row, or updates the row its object URI already holds. */
const remoteStatusRowStatement = (
  db: D1Database,
  row: RemoteStatus,
  inReplyToUri: string | undefined,
): D1PreparedStatement =>
  d1PrepareTyped(
    db,
    upsertRemoteStatusSql(
      row.id,
      row.actorUri,
      row.objectUri,
      row.url ?? null,
      row.contentHtml,
      row.spoilerText,
      visibilitySql(row.visibility),
      row.sensitive ? 1 : 0,
      row.language.kind === "Present" ? row.language.value : null,
      row.publishedAt,
      JSON.stringify(row.media),
      nowIso(),
      nowIso(),
      inReplyToUri ?? null,
      row.editedAt.kind === "Edited" ? row.editedAt.at : null,
      row.poll.kind === "NoPoll" ? null : JSON.stringify(row.poll),
      JSON.stringify(row.emojis),
      row.quotePolicy.automatic.length === 0 && row.quotePolicy.manual.length === 0
        ? null
        : JSON.stringify(row.quotePolicy),
    ),
  );

/** Retries for a new remote status whose generated id is already taken. */
const ID_COLLISION_RETRIES = 4;

const isIdCollision = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed: remote_statuses\.id/.test(error.message);

/** What the caller just read at an object URI: the cached status, or `undefined` for none. */
export type KnownRemoteStatus = Readonly<{
  objectUri: string;
  row: RemoteStatus | undefined;
}>;

/**
 * Store a remote status, or update the one cached at its object URI. A URI
 * cached as another actor's note is left alone and gives `undefined`: only
 * its author rewrites a note.
 */
export const upsertRemoteStatus = async (
  db: D1Database,
  status: RemoteStatus,
  /** The note's hashtags (`noteHashtags`), which replace the ones stored. */
  tags: ReadonlyArray<string>,
  /** The note's `inReplyTo`, kept to group direct conversations. */
  inReplyToUri?: string,
  /** The caller's read of this URI, which spares reading it again. */
  known?: KnownRemoteStatus,
  /** Writes that commit or fail with the row, run before it. */
  alongside: ReadonlyArray<D1PreparedStatement> = [],
  /**
   * Writes that commit or fail with the row, run after it, as they refer to
   * it. Each is built from the id the row is stored under, which is not
   * `status.id` for a row that exists or a new one whose id was taken.
   */
  after: ReadonlyArray<(id: string) => D1PreparedStatement> = [],
): Promise<Result<RemoteStatus | undefined, RepositoryError>> => {
  const existing =
    known?.objectUri === status.objectUri
      ? ok(known.row)
      : await findRemoteStatusByObjectUri(db, status.objectUri);
  if (existing.isErr()) {
    return err(existing.error);
  }
  if (existing.value && existing.value.actorUri !== status.actorUri) {
    return ok(undefined);
  }
  let persisted = existing.value
    ? { ...status, id: existing.value.id, kind: "RemoteNote" as const }
    : status;
  // A changed tally is the author's count of every vote it has seen, ours
  // included. Settled with the row: a retry reads the new tally as stored.
  const settled =
    existing.value &&
    persisted.poll.kind !== "NoPoll" &&
    JSON.stringify(existing.value.poll) !== JSON.stringify(persisted.poll)
      ? [settleRemotePollVotesStatement(db, existing.value.id)]
      : [];
  // A row replaced since it was read (another `Update` was applied meanwhile)
  // fails the batch: this write was computed from a version that is gone, and
  // would undo the other. The sender's redelivery reads the row again.
  const unreplaced = existing.value
    ? [
        d1PrepareTyped(
          db,
          refuseReplacedRemoteStatusSql(
            existing.value.id,
            existing.value.editedAt.kind === "Edited" ? existing.value.editedAt.at : null,
          ),
        ),
      ]
    : [];
  const written = await runD1(async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        // One transaction: a note is never stored without its tags, so a
        // delivery that failed here is processed again as if it never ran.
        // The row comes first (the tag index holds a foreign key to it).
        await db.batch([
          ...unreplaced,
          ...alongside,
          remoteStatusRowStatement(db, persisted, inReplyToUri),
          ...remoteStatusTagStatements(db, persisted.id, persisted.visibility, tags),
          ...settled,
          ...after.map((statement) => statement(persisted.id)),
        ]);
        break;
      } catch (error) {
        // A new row whose id another isolate already stored (same instant, same
        // random low bits): retry at the same instant with new random low bits.
        if (existing.value || attempt >= ID_COLLISION_RETRIES || !isIdCollision(error)) {
          throw error;
        }
        const rerolled = StatusId.parse(rerollEntityId(persisted.id));
        if (rerolled.isErr()) {
          throw error;
        }
        persisted = { ...persisted, id: rerolled.value };
      }
    }
    return persisted;
  });
  if (written.isErr()) {
    return err(written.error);
  }
  return ok(written.value);
};

/**
 * Replace the row of `status.id`, which did not read as a status
 * (`StoredRowInvalid`), with `status` and its tags, in one batch. The upsert
 * keeps a stored `edited_at` when the status has none, so it is cleared first.
 */
export const overwriteRemoteStatus = async (
  db: D1Database,
  status: RemoteStatus,
  tags: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1Batch(db, [
    db
      .prepare("UPDATE remote_statuses SET edited_at = NULL WHERE id = ? AND actor_uri = ?")
      .bind(status.id, status.actorUri),
    remoteStatusRowStatement(db, status, undefined),
    ...remoteStatusTagStatements(db, status.id, status.visibility, tags),
  ]);
  return written.map(() => undefined);
};

/** Cached remote statuses' ids and authors, keyed by object URI. */
export const findRemoteStatusRefsByObjectUris = async (
  db: D1Database,
  objectUris: ReadonlyArray<string>,
): Promise<
  Result<ReadonlyMap<string, Readonly<{ id: string; actorUri: string }>>, RepositoryError>
> => {
  const unique = [...new Set(objectUris)];
  if (unique.length === 0) {
    return ok(new Map());
  }
  const rows = await runD1(async () =>
    queryTyped(
      db,
      findRemoteStatusRefsByObjectUrisSql(jsonStringArray(unique)),
      IdObjectUriActorUriRow,
    ),
  );
  return rows.isErr()
    ? err(rows.error)
    : ok(
        new Map(rows.value.map((row) => [row.object_uri, { id: row.id, actorUri: row.actor_uri }])),
      );
};

/** How many remote statuses one pass of the tag backfill reads. */
const REMOTE_TAG_BACKFILL_PAGE = 100;

export type RemoteTagBackfillPage = Readonly<{
  /** Statuses read in this pass. */
  scanned: number;
  /** Whether another pass should follow. */
  chained: boolean;
}>;

/**
 * One pass of the remote tag backfill: index a page of the remote statuses
 * marked `tags_indexed = 0` under the hashtags their stored HTML reads as
 * (the note's `tag` is not kept), newest first, and mark them indexed. Those
 * are the statuses stored before the index, and the ones migration 0136 sent
 * back. The page is one batch of four statements, each of which
 * skips a status a delivery has indexed since the page was read. Another
 * pass follows a full page that indexed something: a full page that indexed
 * nothing would be read again as it is.
 */
export const indexMissingRemoteTags = async (
  db: D1Database,
  pageSize: number = REMOTE_TAG_BACKFILL_PAGE,
): Promise<Result<RemoteTagBackfillPage, RepositoryError>> => {
  const rows = await runD1(async () =>
    queryTyped(db, listUnindexedRemoteStatusesSql(pageSize), UnindexedRemoteStatusRow),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  if (rows.value.length === 0) {
    return ok({ scanned: 0, chained: false });
  }
  const entries = rows.value.flatMap((row) => {
    const tags = htmlHashtags(row.content_html);
    return tags.length === 0 ? [] : [{ row, tags }];
  });
  const entriesJson = (of: typeof entries): string =>
    JSON.stringify(of.map(({ row, tags }) => [row.id, tags]));
  const idsJson = jsonStringArray(rows.value.map((row) => row.id));
  const indexed = await runD1Batch(db, [
    d1PrepareTyped(db, deleteUnindexedRemoteStatusTagsSql(idsJson)),
    d1PrepareTyped(db, insertUnindexedRemoteStatusTagsSql(entriesJson(entries))),
    d1PrepareTyped(
      db,
      insertUnindexedRemoteTagNamesSql(
        entriesJson(
          entries.filter(
            ({ row }) =>
              // An unreadable visibility keeps the names out of search, as a direct note's.
              !Visibility.isRestricted(
                Visibility.fromMastodon(row.visibility).unwrapOr(Visibility.Direct),
              ),
          ),
        ),
      ),
    ),
    d1PrepareTyped(db, markRemoteStatusesTagsIndexedSql(idsJson)),
  ]);
  if (indexed.isErr()) {
    return err(indexed.error);
  }
  const marked = (indexed.value.at(-1)?.results ?? []).length;
  return ok({
    scanned: rows.value.length,
    chained: rows.value.length === pageSize && marked > 0,
  });
};

/**
 * Delete a cached remote status, only when `actorUri` (the Delete's signer)
 * wrote it. The local boosts of it go with it, and are returned.
 */
export const deleteRemoteStatusByObjectUri = async (
  db: D1Database,
  objectUri: string,
  actorUri: string,
): Promise<Result<RemovedRemoteStatus | undefined, RepositoryError>> => {
  const batched = await runD1Batch(db, [
    d1PrepareTyped(db, listLocalBoostsOfRemoteObjectSql(objectUri, actorUri)),
    d1PrepareTyped(db, deleteRemoteStatusByObjectUriSql(objectUri, actorUri)),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  const [boosts, deleted] = batched.value;
  const row = parseRows(DeletedRemoteStatusRowSchema, deleted?.results)[0];
  return ok(
    row
      ? {
          id: row.id,
          public: row.visibility === "public",
          boosts: removedBoostsFromRows(boosts?.results),
        }
      : undefined,
  );
};

const DeletedRemoteStatusRowSchema = z.object({ id: z.string().min(1), visibility: z.string() });

/** Delete a cached remote status by id, only when `actorUri` wrote it. */
export const deleteRemoteStatusById = async (
  db: D1Database,
  id: string,
  actorUri: string,
): Promise<Result<RemovedRemoteStatus | undefined, RepositoryError>> => {
  // The local boosts of it go with it (the FK cascade); read them first so their streams hear it.
  const batched = await runD1Batch(db, [
    db
      .prepare(
        `SELECT s.id, s.account_id FROM statuses s
         JOIN remote_statuses r ON r.id = s.reblog_of_remote_id
         WHERE r.id = ? AND r.actor_uri = ? AND s.kind = 'LocalReblog'`,
      )
      .bind(id, actorUri),
    db
      .prepare(
        "DELETE FROM remote_statuses WHERE id = ? AND actor_uri = ? RETURNING id, visibility",
      )
      .bind(id, actorUri),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  const [boosts, deleted] = batched.value;
  const row = parseRows(DeletedRemoteStatusRowSchema, deleted?.results)[0];
  return ok(
    row
      ? {
          id: row.id,
          public: row.visibility === "public",
          boosts: removedBoostsFromRows(boosts?.results),
        }
      : undefined,
  );
};

/** Set a cached remote status's sensitive flag. The status's visibility, or `undefined` when `actorUri` wrote no such status. */
export const setRemoteStatusSensitive = async (
  db: D1Database,
  id: string,
  actorUri: string,
  sensitive: boolean,
): Promise<Result<Readonly<{ public: boolean }> | undefined, RepositoryError>> =>
  runD1(async () => {
    const found = await db
      .prepare(
        "UPDATE remote_statuses SET sensitive = ? WHERE id = ? AND actor_uri = ? RETURNING visibility",
      )
      .bind(sensitive ? 1 : 0, id, actorUri)
      .first();
    const row = parseRows(VisibilityRow, [found])[0];
    return row ? { public: row.visibility === "public" } : undefined;
  });

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([RemoteStatusRowSchema]);
