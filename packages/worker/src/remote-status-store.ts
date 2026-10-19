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
import { jsonStringArray, runD1, type RepositoryError } from "./d1";
import { parseJsonText, RemoteStatusRowSchema, toRepositoryError } from "./schemas";
import { visibilitySql } from "./sql-enums";
import { htmlHashtags } from "./html";
import { matchesTagFilters, type StatusCursor, type TagStatusFilters } from "./status-store";
import { queryTyped, runTyped } from "./typed-sql";
import {
  deleteRemoteStatusByObjectUri as deleteRemoteStatusByObjectUriSql,
  findRemoteStatusById as findRemoteStatusByIdSql,
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
    return persisted;
  });
  if (written.isErr()) {
    return err(written.error);
  }
  return ok(written.value);
};

/** Store the link preview built for a remote status. */
export const setRemoteStatusCard = async (
  db: D1Database,
  statusId: string,
  cardJson: string,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await queryTyped(db, setRemoteStatusCardSql(statusId, cardJson));
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
export const listTagRemoteStatuses = async (
  db: D1Database,
  tag: string,
  limit: number,
  cursor: StatusCursor = {},
  filters: TagStatusFilters = { any: [], all: [], none: [], onlyMedia: false },
): Promise<Result<RemoteStatus[], RepositoryError>> => {
  const window = Math.max(200, limit * 4);
  const fetched = await listPublicRemoteStatuses(db, window);
  if (fetched.isErr()) {
    return fetched;
  }
  const minId = cursor.minId ?? "";
  const sinceId = cursor.sinceId ?? "";
  const maxId = cursor.maxId ?? "";
  const keep = (status: RemoteStatus): boolean => {
    if (!matchesTagFilters(new Set(htmlHashtags(status.contentHtml)), tag, filters)) {
      return false;
    }
    if (filters.onlyMedia && status.media.length === 0) {
      return false;
    }
    if (minId.length > 0) {
      return status.id > minId;
    }
    if (sinceId.length > 0) {
      return status.id > sinceId;
    }
    if (maxId.length > 0) {
      return status.id < maxId;
    }
    return true;
  };
  const matching = fetched.value.filter(keep);
  matching.sort((left, right) =>
    minId.length > 0 ? left.id.localeCompare(right.id) : right.id.localeCompare(left.id),
  );
  return ok(matching.slice(0, limit));
};

export const deleteRemoteStatusByObjectUri = async (
  db: D1Database,
  objectUri: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(db, deleteRemoteStatusByObjectUriSql(objectUri));
    return rows.length > 0;
  });
