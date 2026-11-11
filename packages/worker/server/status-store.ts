import { extractHashtags, warmSchemas } from "@tstodon/core";
import {
  AccountId,
  IsoInstant,
  type LocalNote,
  type LocalReblog,
  type LocalStatus as LocalStatusValue,
  MediaId,
  type RemovedBoost,
  StatusId,
  StatusQuoteTarget,
  StatusTarget,
  type StatusTargetValue,
  Visibility,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import {
  jsonStringArray,
  okValues,
  parseRows,
  type RepositoryError,
  runD1,
  runD1Batch,
  sqlInJsonEach,
} from "./d1";
import { removedBoostsFromRows } from "./removed-boost";
import { deletedMediaObjectKeys } from "./media-store";
import { visibilitySql } from "./sql-enums";
import { recordTagNames, searchableTagNames } from "./hashtags";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import {
  attachMediaToStatus as attachMediaToStatusSql,
  countStatuses as countStatusesSql,
  deleteLocalBoostsOfOwned as deleteLocalBoostsOfOwnedSql,
  deleteReblogOf as deleteReblogOfSql,
  deleteStatusMedia as deleteStatusMediaSql,
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

const NullableIdRow = z.object({ id: z.string().nullable() });
const IdInReplyToUriRow = z.object({ id: z.string(), in_reply_to_uri: z.string() });
const IdRow = z.object({ id: z.string() });
const MediaRow = z.object({ status_id: z.string(), id: z.string() });
const CountRow = z.object({ count: z.union([z.number(), z.bigint()]) });

export const StatusRowSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  kind: z.string().min(1),
  reblog_of_id: z.string().nullable(),
  reblog_of_remote_id: z.string().nullable(),
  in_reply_to_id: z.string().nullable(),
  content_text: z.string(),
  content_html: z.string(),
  visibility: z.string(),
  sensitive: z.number(),
  spoiler_text: z.string(),
  language: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  poll_id: z.string().nullable(),
});

export type StatusRow = z.infer<typeof StatusRowSchema>;

export const STATUS_SELECT = `id, account_id, kind, reblog_of_id, reblog_of_remote_id, in_reply_to_id, content_text, COALESCE(content_html, '') AS content_html, visibility, sensitive, COALESCE(spoiler_text, '') AS spoiler_text, language, created_at, updated_at, poll_id`;

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
    const target = StatusTarget.parse(
      row.reblog_of_id
        ? { kind: "LocalStatus", statusId: row.reblog_of_id }
        : { kind: "RemoteStatus", statusId: row.reblog_of_remote_id },
    );
    if (target.isErr()) {
      return err({ kind: "RepositoryError", message: "reblog missing target" });
    }
    const reblogVisibility = Visibility.fromMastodon(row.visibility);
    if (reblogVisibility.isErr()) {
      return err({ kind: "RepositoryError", message: "invalid visibility" });
    }
    return ok({
      kind: "LocalReblog",
      id: id.value,
      accountId: accountId.value,
      target: target.value,
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
  const results = await queryTyped(db, listMediaIdsForStatusSql(statusId), NullableIdRow);
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
  const queried = await runD1(async () => queryTyped(db, findStatusByIdSql(id), StatusRowSchema));
  if (queried.isErr()) {
    return err(queried.error);
  }
  const row = queried.value[0];
  if (!row) {
    return ok(undefined);
  }
  const media = await runD1(() => mediaIdsFor(db, id));
  if (media.isErr()) {
    return err(media.error);
  }
  return statusFromRow(row, media.value);
};

export const findStatusesByIds = async (
  db: D1Database,
  ids: ReadonlyArray<string>,
): Promise<Result<Map<string, LocalStatusValue>, RepositoryError>> => {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  if (unique.length === 0) {
    return ok(new Map<string, LocalStatusValue>());
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
  return ok(new Map(hydrated.map((status) => [status.id, status])));
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
    queryTyped(db, listStatusReplyUrisSql(jsonStringArray(unique)), IdInReplyToUriRow),
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
    ...note.mediaIds.map((mediaId, position) =>
      d1PrepareTyped(db, attachMediaToStatusSql(note.id, mediaId, note.accountId, position)),
    ),
    ...recordTagNames(db, searchableTagNames(note.visibility, extractHashtags(note.text))),
  ];
  const batched = await runD1Batch(db, statements);
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok(undefined);
};

/**
 * The `(local_status_id, remote_status_id)` pair of columns that names a
 * target: exactly one is set, as the tables' CHECK asks.
 */
export const statusTargetColumns = (
  target: StatusTargetValue,
): readonly [local: string | null, remote: string | null] =>
  target.kind === "LocalStatus" ? [target.statusId, null] : [null, target.statusId];

/** The account's existing boost of a status, if it has one. */
export const findLocalReblog = async (
  db: D1Database,
  accountId: string,
  target: StatusTargetValue,
): Promise<Result<StatusId | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      findLocalReblogSql(accountId, ...statusTargetColumns(target)),
      IdRow,
    );
    const id = StatusId.parse(rows[0]?.id ?? "");
    return id.isOk() ? id.value : undefined;
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
        ...statusTargetColumns(reblog.target),
        reblog.createdAt,
        reblog.createdAt,
        Visibility.toMastodon(reblog.visibility),
      ),
    );
  });

/** Replace a note's media: detach the current attachments, then attach the new set in its order. */
export const replaceStatusMedia = async (
  db: D1Database,
  statusId: string,
  accountId: string,
  mediaIds: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> => {
  const batched = await runD1Batch(db, [
    d1PrepareTyped(db, detachStatusMediaSql(statusId, accountId)),
    ...mediaIds.map((mediaId, position) =>
      d1PrepareTyped(db, attachMediaToStatusSql(statusId, mediaId, accountId, position)),
    ),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok(undefined);
};

/**
 * Apply an edited note to its status row, and store the tag names it now
 * uses in the same batch. False when the row is not the author's.
 */
export const updateLocalNote = async (
  db: D1Database,
  note: LocalNote,
  updatedAt: string,
): Promise<Result<boolean, RepositoryError>> => {
  const batched = await runD1Batch(db, [
    d1PrepareTyped(
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
    ),
    ...recordTagNames(db, searchableTagNames(note.visibility, extractHashtags(note.text))),
  ]);
  return batched.map((results) => (results[0]?.results ?? []).length > 0);
};

/**
 * What happens to a deleted status's media: `Delete` removes the rows (and
 * the caller the objects), as Mastodon's `RemoveStatusService`; `Keep` leaves
 * them unattached so a redraft can attach them again (Mastodon's `redraft`),
 * until the media sweep removes them.
 */
export type StatusMediaOnDelete = "Delete" | "Keep";

export type DeletedStatus = Readonly<{
  boosts: ReadonlyArray<RemovedBoost>;
  /** The bucket keys of the media rows deleted with the status. */
  mediaObjectKeys: ReadonlyArray<string>;
}>;

/**
 * Delete the account's own status along with the local boosts of it (the
 * foreign key would only null their target) and, unless `media` is `Keep`,
 * its media: what it holds and what an edit took off it that its history
 * still shows. Resolves to the boosts removed and the media's object keys,
 * or `undefined` when the account owns no such status.
 */
export const deleteStatus = async (
  db: D1Database,
  id: string,
  accountId: string,
  media: StatusMediaOnDelete,
): Promise<Result<DeletedStatus | undefined, RepositoryError>> => {
  const batched = await runD1Batch(db, [
    d1PrepareTyped(db, deleteLocalBoostsOfOwnedSql(id, accountId)),
    // Before the status: its edit history, which names media an edit took
    // off, goes with it, and the foreign key would only detach the rest.
    ...(media === "Delete" ? [d1PrepareTyped(db, deleteStatusMediaSql(id, accountId))] : []),
    d1PrepareTyped(db, deleteStatusOwnedSql(id, accountId)),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  const boosts = batched.value[0];
  const deleted = batched.value.at(-1);
  const deletedMedia = media === "Delete" ? batched.value[1] : undefined;
  return ok(
    (deleted?.results ?? []).length > 0
      ? {
          boosts: removedBoostsFromRows(boosts?.results),
          mediaObjectKeys: deletedMediaObjectKeys(deletedMedia?.results),
        }
      : undefined,
  );
};

/** Set a note's sensitive flag. False when the row is not the account's own note. */
export const setNoteSensitive = async (
  db: D1Database,
  id: string,
  accountId: string,
  sensitive: boolean,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const changed = await db
      .prepare(
        "UPDATE statuses SET sensitive = ? WHERE id = ? AND account_id = ? AND kind = 'LocalNote'",
      )
      .bind(sensitive ? 1 : 0, id, accountId)
      .run();
    return changed.meta.changes > 0;
  });

export const deleteReblogOf = async (
  db: D1Database,
  accountId: string,
  target: StatusTargetValue,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteReblogOfSql(accountId, ...statusTargetColumns(target)));
  });

export const countStatuses = async (db: D1Database): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, countStatusesSql(), CountRow);
    return Number(rows[0]?.count ?? 0);
  });

export const hydrateStatusRows = async (
  db: D1Database,
  rows: unknown[],
): Promise<LocalStatusValue[]> => {
  const statusRows = parseRows(StatusRowSchema, rows);
  if (statusRows.length === 0) {
    return [];
  }
  const { results } = await db
    .prepare(
      `SELECT status_id, id FROM media_attachments WHERE status_id ${sqlInJsonEach()} ORDER BY position`,
    )
    .bind(jsonStringArray(statusRows.map((row) => row.id)))
    .all();
  const mediaByStatus = Map.groupBy(
    okValues(
      parseRows(MediaRow, results).map((media) =>
        MediaId.parse(media.id).map((id) => ({ statusId: media.status_id, id })),
      ),
    ),
    (media) => media.statusId,
  );
  return okValues(
    statusRows.map((row) =>
      statusFromRow(
        row,
        (mediaByStatus.get(row.id) ?? []).map((media) => media.id),
      ),
    ),
  );
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

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([StatusRowSchema]);
