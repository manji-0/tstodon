import {
  IsoInstant,
  type RemoteAttachment,
  RemoteAttachmentSchema,
  RemoteStatus,
  StatusId,
  Visibility,
} from "@tstodon/domain";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, type RepositoryError, runD1, runD1Batch } from "./d1";
import { parseJsonText } from "./json-column";
import { toRepositoryError } from "./d1";
import { visibilitySql } from "./sql-enums";
import { htmlHashtags } from "./html";
import {
  deleteRemoteStatusByObjectUri as deleteRemoteStatusByObjectUriSql,
  findRemoteStatusById as findRemoteStatusByIdSql,
  findRemoteStatusByObjectUri as findRemoteStatusByObjectUriSql,
  findRemoteStatusesByIds as findRemoteStatusesByIdsSql,
  findRemoteStatusRefsByObjectUris as findRemoteStatusRefsByObjectUrisSql,
  listUnindexedRemoteStatuses as listUnindexedRemoteStatusesSql,
  markRemoteStatusTagsIndexed as markRemoteStatusTagsIndexedSql,
  upsertRemoteStatus as upsertRemoteStatusSql,
} from "./generated/prisma/sql";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";

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
  media_json: z.string(),
  card_json: z.string().nullable(),
});

export type RemoteStatusRow = z.infer<typeof RemoteStatusRowSchema>;

export const parseRemoteStatusRow = schemaResult(RemoteStatusRowSchema);

const mediaFromJson = (raw: string): ReadonlyArray<RemoteAttachment> => {
  const parsed = schemaResult(z.array(RemoteAttachmentSchema))(parseJsonText(raw).unwrapOr([]));
  return parsed.isOk() ? parsed.value : [];
};

export const remoteStatusFromRow = (
  row: RemoteStatusRow,
): Result<RemoteStatus, RepositoryError> => {
  const id = StatusId.parse(row.id);
  const publishedAt = IsoInstant.parse(row.published_at);
  const visibility = Visibility.fromMastodon(row.visibility);
  if (id.isErr() || publishedAt.isErr() || visibility.isErr()) {
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
    media: mediaFromJson(row.media_json),
    ...(row.url ? { url: row.url } : {}),
  }).mapErr(() => toRepositoryError("invalid remote status row"));
};

const readRemoteStatus = async (
  queried: Result<unknown, RepositoryError>,
): Promise<Result<RemoteStatus | undefined, RepositoryError>> => {
  if (queried.isErr()) {
    return err(queried.error);
  }
  if (!queried.value) {
    return ok(undefined);
  }
  const row = parseRemoteStatusRow(queried.value);
  if (row.isErr()) {
    return err(toRepositoryError("invalid remote status row"));
  }
  return remoteStatusFromRow(row.value);
};

export const findRemoteStatusById = async (
  db: D1Database,
  id: string,
): Promise<Result<RemoteStatus | undefined, RepositoryError>> =>
  readRemoteStatus(
    await runD1(async () => {
      const rows = await queryTyped(db, findRemoteStatusByIdSql(id));
      return rows[0];
    }),
  );

/** Stored remote statuses keyed by id; unknown or unreadable rows are left out. */
export const findRemoteStatusesByIds = async (
  db: D1Database,
  ids: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, RemoteStatus>, RepositoryError>> => {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  const statuses = new Map<string, RemoteStatus>();
  if (unique.length === 0) {
    return ok(statuses);
  }
  const queried = await runD1(async () =>
    queryTyped(db, findRemoteStatusesByIdsSql(jsonStringArray(unique))),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  for (const raw of queried.value) {
    const status = await readRemoteStatus(ok(raw));
    if (status.isOk() && status.value) {
      statuses.set(status.value.id, status.value);
    }
  }
  return ok(statuses);
};

export const findRemoteStatusByObjectUri = async (
  db: D1Database,
  objectUri: string,
): Promise<Result<RemoteStatus | undefined, RepositoryError>> =>
  readRemoteStatus(
    await runD1(async () => {
      const rows = await queryTyped(db, findRemoteStatusByObjectUriSql(objectUri));
      return rows[0];
    }),
  );

/**
 * Replace a remote status's indexed tags with the hashtags in its HTML, and
 * mark the row as indexed so the backfill job skips it.
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
  ]);
};

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
  const persisted = existing.value
    ? { ...status, id: existing.value.id, kind: "RemoteNote" as const }
    : status;
  const written = await runD1(async () => {
    await runTyped(
      db,
      upsertRemoteStatusSql(
        persisted.id,
        persisted.actorUri,
        persisted.objectUri,
        persisted.url ?? null,
        persisted.contentHtml,
        persisted.spoilerText,
        visibilitySql(persisted.visibility),
        persisted.sensitive ? 1 : 0,
        persisted.language.kind === "Present" ? persisted.language.value : null,
        persisted.publishedAt,
        JSON.stringify(persisted.media),
        nowIso(),
        nowIso(),
        inReplyToUri ?? null,
      ),
    );
    // The row has to exist before its tags (the index holds a foreign key).
    await replaceRemoteStatusTags(db, persisted.id, htmlHashtags(persisted.contentHtml));
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
    queryTyped<{ id: string; object_uri: string; actor_uri: string }>(
      db,
      findRemoteStatusRefsByObjectUrisSql(jsonStringArray(unique)),
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
    queryTyped<{ id: string; content_html: string }>(db, listUnindexedRemoteStatusesSql(limit)),
  );
  if (rows.isErr()) {
    return;
  }
  for (const row of rows.value) {
    await replaceRemoteStatusTags(db, row.id, htmlHashtags(row.content_html));
  }
};

/** Delete a cached remote status, only when `actorUri` (the Delete's signer) wrote it. */
export const deleteRemoteStatusByObjectUri = async (
  db: D1Database,
  objectUri: string,
  actorUri: string,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(
      db,
      deleteRemoteStatusByObjectUriSql(objectUri, actorUri),
    );
    return rows[0]?.id;
  });

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([RemoteStatusRowSchema]);
