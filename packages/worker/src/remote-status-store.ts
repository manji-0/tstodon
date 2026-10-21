import {
  IsoInstant,
  RemoteAttachmentSchema,
  RemoteStatus,
  StatusId,
  Visibility,
  type RemoteAttachment,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, runD1, runD1Batch, type RepositoryError } from "./d1";
import { parseJsonText, RemoteStatusRowSchema, toRepositoryError } from "./schemas";
import { visibilitySql } from "./sql-enums";
import { htmlHashtags } from "./html";
import {
  listUnindexedRemoteStatuses as listUnindexedRemoteStatusesSql,
  markRemoteStatusTagsIndexed as markRemoteStatusTagsIndexedSql,
} from "./generated/prisma/sql";
import type { StatusCursor, TagStatusFilters } from "./status-store";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import {
  deleteRemoteStatusByObjectUri as deleteRemoteStatusByObjectUriSql,
  findRemoteStatusById as findRemoteStatusByIdSql,
  findRemoteStatusesByIds as findRemoteStatusesByIdsSql,
  findRemoteStatusByObjectUri as findRemoteStatusByObjectUriSql,
  listPublicRemoteStatuses as listPublicRemoteStatusesSql,
  listRemoteStatusCards as listRemoteStatusCardsSql,
  setRemoteStatusCard as setRemoteStatusCardSql,
  upsertRemoteStatus as upsertRemoteStatusSql,
} from "./generated/prisma/sql";

export type RemoteStatusRow = z.infer<typeof RemoteStatusRowSchema>;

const parseRemoteStatusRow = schemaResult(RemoteStatusRowSchema);

const mediaFromJson = (raw: string): ReadonlyArray<RemoteAttachment> => {
  const parsed = schemaResult(z.array(RemoteAttachmentSchema))(parseJsonText(raw).unwrapOr([]));
  return parsed.isOk() ? parsed.value : [];
};

const remoteStatusFromRow = (row: RemoteStatusRow): Result<RemoteStatus, RepositoryError> => {
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

/** Store the link preview built for a remote status, with the link it was unfurled from. */
export const setRemoteStatusCard = async (
  db: D1Database,
  statusId: string,
  cardJson: string,
  cardUrl: string,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await queryTyped(db, setRemoteStatusCardSql(statusId, cardJson, cardUrl));
  });
  return written.map(() => undefined);
};

/** Link previews for the given remote statuses, keyed by status id. */
export const listRemoteStatusCards = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, string>, RepositoryError>> => {
  const unique = [...new Set(statusIds.filter((id) => id.length > 0))];
  if (unique.length === 0) {
    return ok(new Map<string, string>());
  }
  const queried = await runD1(async () =>
    queryTyped<{ id: string; card_json: string }>(
      db,
      listRemoteStatusCardsSql(jsonStringArray(unique)),
    ),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(new Map(queried.value.map((row) => [row.id, row.card_json])));
};

export const listPublicRemoteStatuses = async (
  db: D1Database,
  limit: number,
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(db, listPublicRemoteStatusesSql(limit));
    const statuses: RemoteStatus[] = [];
    for (const raw of results) {
      const row = parseRemoteStatusRow(raw);
      if (row.isErr()) {
        continue;
      }
      const parsed = remoteStatusFromRow(row.value);
      if (parsed.isOk()) {
        statuses.push(parsed.value);
      }
    }
    return statuses;
  });

/**
 * Remote statuses on a tag timeline. Tags are read from the stored HTML (the
 * same `#tag` extraction the local notes use), over a bounded window of recent
 * public statuses, because the remote rows carry no tag index.
 */
const REMOTE_STATUS_SELECT = `s.id, s.actor_uri, s.object_uri, s.url, s.content_html, s.spoiler_text,
       s.visibility, s.sensitive, s.language, s.published_at, s.media_json, s.card_json`;

export const listTagRemoteStatuses = async (
  db: D1Database,
  tag: string,
  limit: number,
  cursor: StatusCursor = {},
  filters: TagStatusFilters = { any: [], all: [], none: [], onlyMedia: false },
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
    const conditions = [
      "s.visibility = 'public'",
      "EXISTS (SELECT 1 FROM remote_status_tags t WHERE t.status_id = s.id AND t.tag = ?)",
    ];
    const binds: string[] = [tag.replace(/^#/, "").toLowerCase()];
    if (filters.any.length > 0) {
      conditions.push(
        `EXISTS (SELECT 1 FROM remote_status_tags t WHERE t.status_id = s.id AND t.tag IN (${filters.any.map(() => "?").join(", ")}))`,
      );
      binds.push(...filters.any.map((value) => value.toLowerCase()));
    }
    for (const required of filters.all) {
      conditions.push(
        "EXISTS (SELECT 1 FROM remote_status_tags t WHERE t.status_id = s.id AND t.tag = ?)",
      );
      binds.push(required.toLowerCase());
    }
    for (const denied of filters.none) {
      conditions.push(
        "NOT EXISTS (SELECT 1 FROM remote_status_tags t WHERE t.status_id = s.id AND t.tag = ?)",
      );
      binds.push(denied.toLowerCase());
    }
    if (filters.onlyMedia) {
      conditions.push("s.media_json NOT IN ('[]', '')");
    }
    // Mastodon's id cursors, newest first unless `min_id` pages upward.
    const minId = cursor.minId ?? "";
    const sinceId = cursor.sinceId ?? "";
    const maxId = cursor.maxId ?? "";
    const cursorId = minId || sinceId || maxId;
    const cursorWhere =
      cursorId.length > 0 ? (maxId && !minId && !sinceId ? "AND s.id < ?" : "AND s.id > ?") : "";
    const order = minId.length > 0 ? "ORDER BY s.id ASC" : "ORDER BY s.id DESC";
    const { results } = await db
      .prepare(
        `SELECT ${REMOTE_STATUS_SELECT} FROM remote_statuses s
         WHERE ${conditions.join(" AND ")} ${cursorWhere} ${order} LIMIT ?`,
      )
      .bind(...binds, ...(cursorId.length > 0 ? [cursorId] : []), limit)
      .all();
    const statuses: RemoteStatus[] = [];
    for (const raw of results ?? []) {
      const row = parseRemoteStatusRow(raw);
      if (row.isErr()) {
        continue;
      }
      const parsed = remoteStatusFromRow(row.value);
      if (parsed.isOk()) {
        statuses.push(parsed.value);
      }
    }
    return statuses;
  });

/** Public remote statuses whose preview card was unfurled from `url` (the link timeline). */
export const listLinkRemoteStatuses = async (
  db: D1Database,
  url: string,
  limit: number,
  cursor: StatusCursor = {},
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
    const minId = cursor.minId ?? "";
    const sinceId = cursor.sinceId ?? "";
    const maxId = cursor.maxId ?? "";
    const cursorId = minId || sinceId || maxId;
    const cursorWhere =
      cursorId.length > 0 ? (maxId && !minId && !sinceId ? "AND s.id < ?" : "AND s.id > ?") : "";
    const order = minId.length > 0 ? "ORDER BY s.id ASC" : "ORDER BY s.id DESC";
    const { results } = await db
      .prepare(
        `SELECT ${REMOTE_STATUS_SELECT} FROM remote_statuses s
         WHERE s.card_url = ? AND s.visibility = 'public' ${cursorWhere} ${order} LIMIT ?`,
      )
      .bind(url, ...(cursorId.length > 0 ? [cursorId] : []), limit)
      .all();
    const statuses: RemoteStatus[] = [];
    for (const raw of results ?? []) {
      const row = parseRemoteStatusRow(raw);
      if (row.isErr()) {
        continue;
      }
      const parsed = remoteStatusFromRow(row.value);
      if (parsed.isOk()) {
        statuses.push(parsed.value);
      }
    }
    return statuses;
  });

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
