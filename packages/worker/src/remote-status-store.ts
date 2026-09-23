import { IsoInstant, RemoteStatus, StatusId, Visibility } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import { RemoteStatusRowSchema, toRepositoryError } from "./schemas";
import { visibilitySql } from "./sql-enums";

export type RemoteStatusRow = z.infer<typeof RemoteStatusRowSchema>;

const parseRemoteStatusRow = schemaResult(RemoteStatusRowSchema);

const remoteStatusSelect = `id, actor_uri, object_uri, url, content_html, spoiler_text, visibility, sensitive, language, published_at`;

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
    await runD1(() =>
      db.prepare(`SELECT ${remoteStatusSelect} FROM remote_statuses WHERE id = ?`).bind(id).first(),
    ),
  );

export const findRemoteStatusByObjectUri = async (
  db: D1Database,
  objectUri: string,
): Promise<Result<RemoteStatus | undefined, RepositoryError>> =>
  readRemoteStatus(
    await runD1(() =>
      db
        .prepare(`SELECT ${remoteStatusSelect} FROM remote_statuses WHERE object_uri = ?`)
        .bind(objectUri)
        .first(),
    ),
  );

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
    await db
      .prepare(
        `INSERT INTO remote_statuses (
           id, actor_uri, object_uri, url, content_html, spoiler_text,
           visibility, sensitive, language, published_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(object_uri) DO UPDATE SET
           content_html = excluded.content_html,
           spoiler_text = excluded.spoiler_text,
           visibility = excluded.visibility,
           sensitive = excluded.sensitive,
           language = excluded.language,
           published_at = excluded.published_at,
           url = excluded.url,
           updated_at = excluded.updated_at`,
      )
      .bind(
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
        nowIso(),
        nowIso(),
      )
      .run();
    return persisted;
  });
  if (written.isErr()) {
    return err(written.error);
  }
  return ok(written.value);
};

export const listPublicRemoteStatuses = async (
  db: D1Database,
  limit: number,
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${remoteStatusSelect} FROM remote_statuses
         WHERE visibility = 'public'
         ORDER BY published_at DESC LIMIT ?`,
      )
      .bind(limit)
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
