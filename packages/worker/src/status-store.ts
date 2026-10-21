import {
  AccountId,
  IsoInstant,
  type LocalNote,
  type LocalReblog,
  type LocalStatus as LocalStatusValue,
  MediaId,
  StatusId,
  StatusQuoteTarget,
  Visibility,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";
import { jsonStringArray, type RepositoryError, runD1, runD1Batch, sqlInJsonEach } from "./d1";
import { parseRow, StatusRowSchema, toRepositoryError } from "./schemas";
import { visibilitySql } from "./sql-enums";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import {
  attachMediaToStatus as attachMediaToStatusSql,
  countStatuses as countStatusesSql,
  deleteReblogOf as deleteReblogOfSql,
  deleteStatusOwned as deleteStatusOwnedSql,
  detachStatusMedia as detachStatusMediaSql,
  findLocalReblog as findLocalReblogSql,
  findStatusById as findStatusByIdSql,
  insertLocalNote as insertLocalNoteSql,
  insertLocalReblog as insertLocalReblogSql,
  listMediaIdsForStatus as listMediaIdsForStatusSql,
  listStatusReplyUris as listStatusReplyUrisSql,
  setStatusReplyUri as setStatusReplyUriSql,
  updateLocalNote as updateLocalNoteSql,
} from "./generated/prisma/sql";

export type StatusRow = z.infer<typeof StatusRowSchema>;

export const STATUS_SELECT = `id, account_id, kind, reblog_of_id, in_reply_to_id, content_text, COALESCE(content_html, '') AS content_html, visibility, sensitive, COALESCE(spoiler_text, '') AS spoiler_text, language, created_at, updated_at, poll_id`;

export const statusSelect = STATUS_SELECT;

export const CONTEXT_ANCESTOR_LIMIT = 40;

/**
 * Mastodon's `GET /statuses/:id/context` bounds: anonymous callers get 40
 * ancestors and 60 descendants at depth 20; authenticated callers get up to
 * 4096 of each at effectively unlimited depth.
 */
export const ContextLimits = {
  anonymous: { ancestors: 40, descendants: 60, depth: 20 },
  authenticated: { ancestors: 4096, descendants: 4096, depth: 4096 },
} as const;

export const statusFromRow = (
  row: StatusRow,
  mediaIds: ReadonlyArray<MediaId> = [],
): Result<LocalStatusValue, RepositoryError> => {
  const id = StatusId.parse(row.id);
  const accountId = AccountId.parse(row.account_id);
  const createdAt = IsoInstant.parse(row.created_at);
  if (id.isErr() || accountId.isErr() || createdAt.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid status ids" });
  }
  if (row.kind === "LocalReblog") {
    if (!row.reblog_of_id) {
      return err({ kind: "RepositoryError", message: "reblog missing target" });
    }
    const reblogOfId = StatusId.parse(row.reblog_of_id);
    if (reblogOfId.isErr()) {
      return err({ kind: "RepositoryError", message: "invalid reblog target" });
    }
    const reblogVisibility = Visibility.fromMastodon(row.visibility);
    if (reblogVisibility.isErr()) {
      return err({ kind: "RepositoryError", message: "invalid visibility" });
    }
    return ok({
      kind: "LocalReblog",
      id: id.value,
      accountId: accountId.value,
      reblogOfId: reblogOfId.value,
      visibility: reblogVisibility.value,
      createdAt: createdAt.value,
    });
  }
  const visibility = Visibility.fromMastodon(row.visibility);
  if (visibility.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid visibility" });
  }
  const language =
    row.language && row.language.length > 0
      ? { kind: "Present" as const, value: row.language }
      : { kind: "None" as const };
  let inReplyToId: StatusId | null = null;
  if (row.in_reply_to_id) {
    const replyTo = StatusId.parse(row.in_reply_to_id);
    if (replyTo.isErr()) {
      return err({ kind: "RepositoryError", message: "invalid in_reply_to_id" });
    }
    inReplyToId = replyTo.value;
  }
  const editedAtValue =
    row.updated_at !== row.created_at ? IsoInstant.parse(row.updated_at) : undefined;
  return ok({
    kind: "LocalNote",
    id: id.value,
    accountId: accountId.value,
    text: row.content_text,
    contentHtml: row.content_html,
    visibility: visibility.value,
    spoilerText: row.spoiler_text,
    sensitive: row.sensitive === 1,
    language,
    quote: StatusQuoteTarget.none,
    mediaIds: [...mediaIds],
    poll: row.poll_id ? { kind: "Present" } : { kind: "None" },
    inReplyToId,
    createdAt: createdAt.value,
    editedAt: editedAtValue?.isOk() ? editedAtValue.value : null,
  });
};

const mediaIdsFor = async (db: D1Database, statusId: string): Promise<MediaId[]> => {
  const results = await queryTyped<{ id: string | null }>(db, listMediaIdsForStatusSql(statusId));
  return results.flatMap((row) => {
    if (!row.id) {
      return [];
    }
    const parsed = MediaId.parse(row.id);
    return parsed.isOk() ? [parsed.value] : [];
  });
};

export const findStatusById = async (
  db: D1Database,
  id: string,
): Promise<Result<LocalStatusValue | undefined, RepositoryError>> => {
  const queried = await runD1(async () => queryTyped(db, findStatusByIdSql(id)));
  if (queried.isErr()) {
    return err(queried.error);
  }
  const raw = queried.value[0];
  if (!raw) {
    return ok(undefined);
  }
  const row = parseRow(StatusRowSchema, raw);
  if (row.isErr()) {
    return err(toRepositoryError("invalid status row"));
  }
  const media = await runD1(() => mediaIdsFor(db, id));
  if (media.isErr()) {
    return err(media.error);
  }
  return statusFromRow(row.value, media.value);
};

export const findStatusesByIds = async (
  db: D1Database,
  ids: ReadonlyArray<string>,
): Promise<Result<Map<string, LocalStatusValue>, RepositoryError>> => {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  const statuses = new Map<string, LocalStatusValue>();
  if (unique.length === 0) {
    return ok(statuses);
  }
  const queried = await runD1(() =>
    db
      .prepare(`SELECT ${statusSelect} FROM statuses WHERE id ${sqlInJsonEach()}`)
      .bind(jsonStringArray(unique))
      .all(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  const hydrated = await hydrateStatusRows(db, queried.value.results ?? []);
  for (const status of hydrated) {
    statuses.set(status.id, status);
  }
  return ok(statuses);
};

/** Record the remote status a local note replies to, by its object URI. */
export const setStatusReplyUri = async (
  db: D1Database,
  statusId: string,
  inReplyToUri: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, setStatusReplyUriSql(statusId, inReplyToUri));
  });

/** Remote parents' object URIs of local notes, keyed by status id; local replies are absent. */
export const listStatusReplyUris = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, string>, RepositoryError>> => {
  const unique = [...new Set(statusIds)];
  if (unique.length === 0) {
    return ok(new Map());
  }
  const rows = await runD1(async () =>
    queryTyped<{ id: string; in_reply_to_uri: string }>(
      db,
      listStatusReplyUrisSql(jsonStringArray(unique)),
    ),
  );
  return rows.isErr()
    ? err(rows.error)
    : ok(new Map(rows.value.map((row) => [row.id, row.in_reply_to_uri])));
};

export const insertLocalNote = async (
  db: D1Database,
  note: LocalNote,
): Promise<Result<void, RepositoryError>> => {
  const statements: D1PreparedStatement[] = [
    d1PrepareTyped(
      db,
      insertLocalNoteSql(
        note.id,
        note.accountId,
        note.inReplyToId,
        note.text,
        note.contentHtml,
        visibilitySql(note.visibility),
        note.sensitive ? 1 : 0,
        note.spoilerText,
        note.language.kind === "Present" ? note.language.value : null,
        note.createdAt,
        note.createdAt,
      ),
    ),
    ...note.mediaIds.map((mediaId) =>
      d1PrepareTyped(db, attachMediaToStatusSql(note.id, mediaId, note.accountId)),
    ),
  ];
  const batched = await runD1Batch(db, statements);
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok(undefined);
};

/** The account's existing boost of a status, if it has one. */
export const findLocalReblog = async (
  db: D1Database,
  accountId: string,
  reblogOfId: string,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(db, findLocalReblogSql(accountId, reblogOfId));
    return rows[0]?.id;
  });

export const insertLocalReblog = async (
  db: D1Database,
  reblog: LocalReblog,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      insertLocalReblogSql(
        reblog.id,
        reblog.accountId,
        reblog.reblogOfId,
        reblog.createdAt,
        reblog.createdAt,
        Visibility.toMastodon(reblog.visibility),
      ),
    );
  });

/** Replace a note's media: detach the current attachments, then attach the new set. */
export const replaceStatusMedia = async (
  db: D1Database,
  statusId: string,
  accountId: string,
  mediaIds: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> => {
  const batched = await runD1Batch(db, [
    d1PrepareTyped(db, detachStatusMediaSql(statusId, accountId)),
    ...mediaIds.map((mediaId) =>
      d1PrepareTyped(db, attachMediaToStatusSql(statusId, mediaId, accountId)),
    ),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok(undefined);
};

/** Apply an edited note to its status row. False when the row is not the author's. */
export const updateLocalNote = async (
  db: D1Database,
  note: LocalNote,
  updatedAt: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(
      db,
      updateLocalNoteSql(
        note.id,
        note.text,
        note.contentHtml,
        visibilitySql(note.visibility),
        note.sensitive ? 1 : 0,
        note.spoilerText,
        note.language.kind === "Present" ? note.language.value : null,
        updatedAt,
        note.accountId,
      ),
    );
    return rows.length > 0;
  });

export const deleteStatus = async (
  db: D1Database,
  id: string,
  accountId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string | null }>(db, deleteStatusOwnedSql(id, accountId));
    return rows.length > 0;
  });

export const deleteReblogOf = async (
  db: D1Database,
  accountId: string,
  reblogOfId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteReblogOfSql(accountId, reblogOfId));
  });

export const countStatuses = async (db: D1Database): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ count: number | bigint }>(db, countStatusesSql());
    return Number(rows[0]?.count ?? 0);
  });

export const hydrateStatusRows = async (
  db: D1Database,
  rows: unknown[],
): Promise<LocalStatusValue[]> => {
  const statusRows: StatusRow[] = [];
  for (const raw of rows) {
    const row = parseRow(StatusRowSchema, raw);
    if (row.isOk()) {
      statusRows.push(row.value);
    }
  }
  if (statusRows.length === 0) {
    return [];
  }
  const mediaByStatus = new Map<string, MediaId[]>();
  const { results } = await db
    .prepare(`SELECT status_id, id FROM media_attachments WHERE status_id ${sqlInJsonEach()}`)
    .bind(jsonStringArray(statusRows.map((row) => row.id)))
    .all<{ status_id: string; id: string }>();
  for (const media of results ?? []) {
    const parsed = MediaId.parse(media.id);
    if (parsed.isErr()) {
      continue;
    }
    const list = mediaByStatus.get(media.status_id) ?? [];
    list.push(parsed.value);
    mediaByStatus.set(media.status_id, list);
  }
  const statuses: LocalStatusValue[] = [];
  for (const row of statusRows) {
    const parsed = statusFromRow(row, mediaByStatus.get(row.id) ?? []);
    if (parsed.isOk()) {
      statuses.push(parsed.value);
    }
  }
  return statuses;
};

/** Local notes answering any of these local statuses, oldest first. */
export const listLocalRepliesToIds = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
  limit: number,
): Promise<Result<LocalStatusValue[], RepositoryError>> => {
  if (statusIds.length === 0 || limit <= 0) {
    return ok([]);
  }
  return runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses
         WHERE kind = 'LocalNote' AND in_reply_to_id ${sqlInJsonEach()}
         ORDER BY id ASC LIMIT ?`,
      )
      .bind(jsonStringArray([...new Set(statusIds)]), limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });
};

/** Local notes answering any of these remote URIs, oldest first. */
export const listLocalRepliesToUris = async (
  db: D1Database,
  uris: ReadonlyArray<string>,
  limit: number,
): Promise<Result<LocalStatusValue[], RepositoryError>> => {
  if (uris.length === 0 || limit <= 0) {
    return ok([]);
  }
  return runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses
         WHERE kind = 'LocalNote' AND in_reply_to_uri ${sqlInJsonEach()}
         ORDER BY id ASC LIMIT ?`,
      )
      .bind(jsonStringArray([...new Set(uris)]), limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });
};
