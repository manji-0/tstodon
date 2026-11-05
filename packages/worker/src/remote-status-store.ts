import {
  IsoInstant,
  type RemoteAttachment,
  RemoteAttachmentSchema,
  type RemoteEmoji,
  RemoteEmojiSchema,
  RemotePoll,
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
} from "./d1";
import { removedBoostsFromRows } from "./removed-boost";
import { parseJsonText } from "./json-column";
import { toRepositoryError } from "./d1";
import { visibilitySql } from "./sql-enums";
import { recordTagNames } from "./hashtags";
import { htmlHashtags } from "./html";
import {
  claimRemoteStatusThreadBackfill as claimRemoteStatusThreadBackfillSql,
  releaseRemoteStatusThreadBackfill as releaseRemoteStatusThreadBackfillSql,
  deleteRemoteStatusByObjectUri as deleteRemoteStatusByObjectUriSql,
  findRemoteStatusById as findRemoteStatusByIdSql,
  findRemoteStatusByObjectUri as findRemoteStatusByObjectUriSql,
  findRemoteStatusesByIds as findRemoteStatusesByIdsSql,
  findRemoteStatusRefsByObjectUris as findRemoteStatusRefsByObjectUrisSql,
  listLocalBoostsOfRemoteObject as listLocalBoostsOfRemoteObjectSql,
  listUnindexedRemoteStatuses as listUnindexedRemoteStatusesSql,
  markRemoteStatusTagsIndexed as markRemoteStatusTagsIndexedSql,
  upsertRemoteStatus as upsertRemoteStatusSql,
} from "./generated/prisma/sql";
import { settleRemotePollVotes } from "./remote-poll-vote-store";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";

const IdRow = z.object({ id: z.string() });
const IdObjectUriActorUriRow = z.object({
  id: z.string(),
  object_uri: z.string(),
  actor_uri: z.string(),
});
const IdContentHtmlRow = z.object({ id: z.string(), content_html: z.string() });

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

export const remoteStatusFromRow = (
  row: RemoteStatusRow,
): Result<RemoteStatus, RepositoryError> => {
  const id = StatusId.parse(row.id);
  const publishedAt = IsoInstant.parse(row.published_at);
  const editedAt = IsoInstant.parse(row.edited_at ?? "").unwrapOr(undefined);
  const visibility = Visibility.fromMastodon(row.visibility);
  if (id.isErr() || publishedAt.isErr() || (row.edited_at && !editedAt) || visibility.isErr()) {
    return err(toRepositoryError("invalid remote status row"));
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
    ...(row.url ? { url: row.url } : {}),
  }).mapErr(() => toRepositoryError("invalid remote status row"));
};

const readRemoteStatus = async (
  queried: Result<RemoteStatusRow | undefined, RepositoryError>,
): Promise<Result<RemoteStatus | undefined, RepositoryError>> => {
  if (queried.isErr()) {
    return err(queried.error);
  }
  return queried.value === undefined ? ok(undefined) : remoteStatusFromRow(queried.value);
};

export const findRemoteStatusById = async (
  db: D1Database,
  id: string,
): Promise<Result<RemoteStatus | undefined, RepositoryError>> =>
  readRemoteStatus(
    await runD1(async () => {
      const rows = await queryTyped(db, findRemoteStatusByIdSql(id), RemoteStatusRowSchema);
      return rows[0];
    }),
  );

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

export const findRemoteStatusByObjectUri = async (
  db: D1Database,
  objectUri: string,
): Promise<Result<RemoteStatus | undefined, RepositoryError>> =>
  readRemoteStatus(
    await runD1(async () => {
      const rows = await queryTyped(
        db,
        findRemoteStatusByObjectUriSql(objectUri),
        RemoteStatusRowSchema,
      );
      return rows[0];
    }),
  );

/**
 * Replace a remote status's indexed tags with the hashtags in its HTML, store
 * their names for hashtag search, and mark the row as indexed so the backfill
 * job skips it.
 */
const replaceRemoteStatusTags = async (
  db: D1Database,
  statusId: string,
  tags: ReadonlyArray<string>,
): Promise<void> => {
  await runD1Batch(db, [
    db.prepare("DELETE FROM remote_status_tags WHERE status_id = ?").bind(statusId),
    ...tags.map((tag) =>
      db
        .prepare("INSERT OR IGNORE INTO remote_status_tags (status_id, tag) VALUES (?, ?)")
        .bind(statusId, tag),
    ),
    d1PrepareTyped(db, markRemoteStatusTagsIndexedSql(statusId)),
    recordTagNames(db, tags),
  ]);
};

/** Insert a remote status row, or update the row its object URI already holds. */
const writeRemoteStatusRow = async (
  db: D1Database,
  row: RemoteStatus,
  inReplyToUri: string | undefined,
): Promise<void> => {
  await runTyped(
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
    ),
  );
};

/** Retries for a new remote status whose generated id is already taken. */
const ID_COLLISION_RETRIES = 4;

const isIdCollision = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed: remote_statuses\.id/.test(error.message);

export const upsertRemoteStatus = async (
  db: D1Database,
  status: RemoteStatus,
  /** The note's `inReplyTo`, kept to group direct conversations. */
  inReplyToUri?: string,
): Promise<Result<RemoteStatus, RepositoryError>> => {
  const existing = await findRemoteStatusByObjectUri(db, status.objectUri);
  if (existing.isErr()) {
    return err(existing.error);
  }
  let persisted = existing.value
    ? { ...status, id: existing.value.id, kind: "RemoteNote" as const }
    : status;
  const written = await runD1(async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await writeRemoteStatusRow(db, persisted, inReplyToUri);
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
    // The row has to exist before its tags (the index holds a foreign key).
    await replaceRemoteStatusTags(db, persisted.id, htmlHashtags(persisted.contentHtml));
    // A changed tally is the author's count of every vote it has seen, ours included.
    if (
      existing.value &&
      persisted.poll.kind !== "NoPoll" &&
      JSON.stringify(existing.value.poll) !== JSON.stringify(persisted.poll)
    ) {
      await settleRemotePollVotes(db, persisted.id);
    }
    return persisted;
  });
  if (written.isErr()) {
    return err(written.error);
  }
  return ok(written.value);
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

/**
 * Cron path: index the tags of remote statuses written before the index
 * existed, a bounded batch per run.
 */
export const indexMissingRemoteTags = async (
  db: D1Database,
  limit: number = 100,
): Promise<void> => {
  const rows = await runD1(async () =>
    queryTyped(db, listUnindexedRemoteStatusesSql(limit), IdContentHtmlRow),
  );
  if (rows.isErr()) {
    return;
  }
  for (const row of rows.value) {
    await replaceRemoteStatusTags(db, row.id, htmlHashtags(row.content_html));
  }
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
    const row = await db
      .prepare(
        "UPDATE remote_statuses SET sensitive = ? WHERE id = ? AND actor_uri = ? RETURNING visibility",
      )
      .bind(sensitive ? 1 : 0, id, actorUri)
      .first<{ visibility: string }>();
    return row ? { public: row.visibility === "public" } : undefined;
  });

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([RemoteStatusRowSchema]);
