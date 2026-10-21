import {
  AccountId,
  IsoInstant,
  MediaId,
  StatusId,
  StatusQuoteTarget,
  Visibility,
  type LocalNote,
  type LocalReblog,
  type LocalStatus as LocalStatusValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, runD1, runD1Batch, sqlInJsonEach, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { parseRow, StatusRowSchema, toRepositoryError } from "./schemas";
import { SUPPRESSED_ACCOUNT_IDS_SQL } from "./social-store";
import { visibilitySql } from "./sql-enums";
import { idCursorFragment, type IdCursor } from "./id-cursor";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import {
  attachMediaToStatus as attachMediaToStatusSql,
  countPinnedStatuses as countPinnedStatusesSql,
  countStatuses as countStatusesSql,
  deleteReblogOf as deleteReblogOfSql,
  deleteStatusOwned as deleteStatusOwnedSql,
  detachStatusMedia as detachStatusMediaSql,
  findStatusById as findStatusByIdSql,
  findStatusUpdatedAt as findStatusUpdatedAtSql,
  insertLocalNote as insertLocalNoteSql,
  listStatusReplyUris as listStatusReplyUrisSql,
  setStatusReplyUri as setStatusReplyUriSql,
  findLocalReblog as findLocalReblogSql,
  insertLocalReblog as insertLocalReblogSql,
  insertStatusEdit as insertStatusEditSql,
  isStatusPinned as isStatusPinnedSql,
  listMediaIdsForStatus as listMediaIdsForStatusSql,
  listPinnedStatuses as listPinnedStatusesSql,
  listStatusCards as listStatusCardsSql,
  listStatusEditSnapshots as listStatusEditSnapshotsSql,
  pinStatus as pinStatusSql,
  unpinStatus as unpinStatusSql,
  updateStatusCard as updateStatusCardSql,
  updateLocalNote as updateLocalNoteSql,
} from "./generated/prisma/sql";

export type StatusRow = z.infer<typeof StatusRowSchema>;

export const STATUS_SELECT = `id, account_id, kind, reblog_of_id, in_reply_to_id, content_text, COALESCE(content_html, '') AS content_html, visibility, sensitive, COALESCE(spoiler_text, '') AS spoiler_text, language, created_at, updated_at, poll_id`;
const statusSelect = STATUS_SELECT;

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

/** Store the previous revision of a status as a history snapshot. */
export const insertStatusEdit = async (
  db: D1Database,
  statusId: string,
  snapshotJson: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, insertStatusEditSql(newEntityId(), statusId, snapshotJson, nowIso()));
  });

/** Previous revisions, newest first. */
export const listStatusEdits = async (
  db: D1Database,
  statusId: string,
): Promise<Result<Record<string, unknown>[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ snapshot_json: string }>(
      db,
      listStatusEditSnapshotsSql(statusId),
    );
    const snapshots: Record<string, unknown>[] = [];
    for (const row of rows) {
      const parsed: unknown = JSON.parse(row.snapshot_json);
      if (parsed !== null && typeof parsed === "object") {
        snapshots.push({ ...parsed });
      }
    }
    return snapshots;
  });

export const findStatusUpdatedAt = async (
  db: D1Database,
  statusId: string,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ updated_at: string }>(db, findStatusUpdatedAtSql(statusId));
    return rows[0]?.updated_at;
  });

/** Store the link preview built for a status, with the link it was unfurled from. */
export const setStatusCard = async (
  db: D1Database,
  statusId: string,
  cardJson: string,
  cardUrl: string,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await queryTyped(db, updateStatusCardSql(statusId, cardJson, cardUrl));
  });
  return written.map(() => undefined);
};

/** Link previews for the given statuses, keyed by status id. */
export const listStatusCards = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, string>, RepositoryError>> => {
  const unique = [...new Set(statusIds.filter((id) => id.length > 0))];
  if (unique.length === 0) {
    return ok(new Map<string, string>());
  }
  const queried = await runD1(async () =>
    queryTyped<{ id: string; card_json: string }>(db, listStatusCardsSql(jsonStringArray(unique))),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(new Map(queried.value.map((row) => [row.id, row.card_json])));
};

export const pinStatus = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, pinStatusSql(accountId, statusId, nowIso()));
  });

export const unpinStatus = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ status_id: string }>(db, unpinStatusSql(accountId, statusId));
    return rows.length > 0;
  });

export const isStatusPinned = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ present: number }>(db, isStatusPinnedSql(accountId, statusId));
    return rows.length > 0;
  });

export const countPinnedStatuses = async (
  db: D1Database,
  accountId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ count: number | bigint }>(
      db,
      countPinnedStatusesSql(accountId),
    );
    return Number(rows[0]?.count ?? 0);
  });

export const listPinnedStatuses = async (
  db: D1Database,
  accountId: string,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(db, listPinnedStatusesSql(accountId));
    return hydrateStatusRows(db, results);
  });

/** Authors silenced or suspended by an admin are hidden from public surfaces. */
export const MODERATED_ACCOUNTS_SQL = `AND account_id NOT IN (SELECT account_id FROM account_moderation)`;

/**
 * Mastodon's `Account.searchable` also drops unapproved local accounts, so
 * trends (unlike the public timeline) skip pending ones. The directory and
 * account search carry the same rule in their own SQL.
 */
export const SEARCHABLE_ACCOUNTS_SQL = `AND account_id NOT IN (SELECT account_id FROM account_flags WHERE pending <> 0)`;

export type StatusCursor = IdCursor;

const cursorFragment = idCursorFragment;

export const listPublicStatuses = async (
  db: D1Database,
  limit: number,
  cursor: StatusCursor = {},
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = cursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses WHERE visibility = 'public' ${MODERATED_ACCOUNTS_SQL} ${where} ${order} LIMIT ?`,
      )
      .bind(...binds, limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

export const listHomeStatuses = async (
  db: D1Database,
  accountId: string,
  limit: number,
  cursor: StatusCursor = {},
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const suppressed = `AND account_id NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL}`;
    const { where, order, binds } = cursorFragment(cursor);
    // Followers who turned reblogs off keep their own boosts out of the feed,
    // and a follow with `languages[]` only keeps statuses in those languages
    // (statuses without a language still pass, as in Mastodon).
    const sql = `SELECT ${statusSelect} FROM statuses
         WHERE visibility != 'direct' AND (account_id = ? OR account_id IN (
           SELECT target_account_id FROM follows WHERE follower_account_id = ? AND kind = 'Accepted'
         ))
         ${suppressed}
         AND (
           account_id = ? OR kind <> 'LocalReblog'
           OR account_id NOT IN (
             SELECT target_account_id FROM follows
             WHERE follower_account_id = ? AND kind = 'Accepted' AND reblogs = 0
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM follows f
           WHERE f.follower_account_id = ? AND f.kind = 'Accepted'
             AND f.target_account_id = statuses.account_id
             AND f.languages_json <> '[]'
             AND COALESCE(statuses.language, '') <> ''
             AND statuses.language NOT IN (SELECT value FROM json_each(f.languages_json))
         )
         ${where} ${order} LIMIT ?`;
    const { results } = await db
      .prepare(sql)
      .bind(
        accountId,
        accountId,
        // `SUPPRESSED_ACCOUNT_IDS_SQL` takes the viewer twice and its clock.
        accountId,
        accountId,
        accountId,
        nowIso(),
        // Reblogs off: the viewer, then the follows being checked.
        accountId,
        accountId,
        // Languages: the follow whose list is checked.
        accountId,
        ...binds,
        limit,
      )
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

export type AccountStatusFilters = Readonly<{
  limit: number;
  cursor?: StatusCursor;
  excludeReplies: boolean;
  excludeReblogs: boolean;
  onlyMedia: boolean;
  tagged?: string | undefined;
}>;

export const listAccountStatusesFiltered = async (
  db: D1Database,
  accountId: string,
  filters: AccountStatusFilters,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const tagged = filters.tagged?.replace(/^#/, "") ?? "";
    const { where, order, binds } = cursorFragment(filters.cursor);
    const sql = `SELECT ${statusSelect} FROM statuses
         WHERE account_id = ?
           AND (? = 0 OR in_reply_to_id IS NULL)
           AND (? = 0 OR kind <> 'LocalReblog')
           AND (? = 0 OR id IN (SELECT status_id FROM media_attachments WHERE status_id IS NOT NULL))
           AND (? = '' OR content_text LIKE ?)
           ${where} ${order} LIMIT ?`;
    const { results } = await db
      .prepare(sql)
      .bind(
        accountId,
        filters.excludeReplies ? 1 : 0,
        filters.excludeReblogs ? 1 : 0,
        filters.onlyMedia ? 1 : 0,
        tagged.length > 0 ? `%#${tagged}%` : "",
        tagged.length > 0 ? `%#${tagged}%` : "",
        ...binds,
        filters.limit,
      )
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

export const searchStatuses = async (
  db: D1Database,
  query: string,
  limit: number,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses WHERE kind = 'LocalNote' ${MODERATED_ACCOUNTS_SQL} AND content_text LIKE ? ORDER BY id DESC LIMIT ?`,
      )
      .bind(`%${query}%`, limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
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

export const listFavouritedStatuses = async (
  db: D1Database,
  accountId: string,
  limit: number,
  cursor: StatusCursor = {},
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = cursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses
         WHERE id IN (SELECT status_id FROM favourites WHERE account_id = ?)
         ${where} ${order} LIMIT ?`,
      )
      .bind(accountId, ...binds, limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

export const listBookmarkedStatuses = async (
  db: D1Database,
  accountId: string,
  limit: number,
  cursor: StatusCursor = {},
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = cursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses
         WHERE id IN (SELECT status_id FROM bookmarks WHERE account_id = ?)
         ${where} ${order} LIMIT ?`,
      )
      .bind(accountId, ...binds, limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

/** Additional tag constraints on a tag timeline (`any[]`/`all[]`/`none[]`). */
export type TagStatusFilters = Readonly<{
  any: ReadonlyArray<string>;
  all: ReadonlyArray<string>;
  none: ReadonlyArray<string>;
  onlyMedia: boolean;
}>;

/**
 * Does `text` carry the primary tag and the `any`/`all`/`none` constraints?
 * Used for remote statuses, whose tags are matched from their stored HTML.
 */
export const matchesTagFilters = (
  present: ReadonlySet<string>,
  tag: string,
  filters: TagStatusFilters,
): boolean => {
  const primary = tag.replace(/^#/, "").toLowerCase();
  if (!present.has(primary)) {
    return false;
  }
  const has = (value: string): boolean => present.has(value.toLowerCase());
  if (filters.any.length > 0 && !filters.any.some(has)) {
    return false;
  }
  if (!filters.all.every(has)) {
    return false;
  }
  return !filters.none.some(has);
};

export const listTagStatuses = async (
  db: D1Database,
  tag: string,
  limit: number,
  cursor: StatusCursor = {},
  filters: TagStatusFilters = { any: [], all: [], none: [], onlyMedia: false },
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = cursorFragment(cursor);
    // Hashtags are matched case-insensitively, like the primary one.
    const patterns = (tags: ReadonlyArray<string>): string[] =>
      tags.flatMap((value) => [`%#${value}%`, `%#${value.toLowerCase()}%`]);
    const contains = (tags: ReadonlyArray<string>): string =>
      tags.length === 0
        ? ""
        : ` AND (${patterns(tags)
            .map(() => "content_text LIKE ?")
            .join(" OR ")})`;
    const containsAll = (tags: ReadonlyArray<string>): string =>
      tags.length === 0
        ? ""
        : ` AND (${tags.map(() => "content_text LIKE ? AND content_text LIKE ?").join(" AND ")})`;
    const excludes = (tags: ReadonlyArray<string>): string =>
      tags.length === 0
        ? ""
        : ` AND ${patterns(tags)
            .map(() => "content_text NOT LIKE ?")
            .join(" AND ")}`;
    const onlyMedia = filters.onlyMedia
      ? " AND id IN (SELECT status_id FROM media_attachments WHERE status_id IS NOT NULL)"
      : "";
    const sql = `SELECT ${statusSelect} FROM statuses
         WHERE kind = 'LocalNote' AND visibility = 'public' ${MODERATED_ACCOUNTS_SQL}
           AND (content_text LIKE ? OR content_text LIKE ?)
           ${contains(filters.any)}${containsAll(filters.all)}${excludes(filters.none)}${onlyMedia}
         ${where} ${order} LIMIT ?`;
    const { results } = await db
      .prepare(sql)
      .bind(
        `%#${tag}%`,
        `%#${tag.toLowerCase()}%`,
        ...patterns(filters.any),
        ...patterns(filters.all),
        ...patterns(filters.none),
        ...binds,
        limit,
      )
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

/** Public local notes whose preview card was unfurled from `url` (the link timeline). */
export const listLinkStatuses = async (
  db: D1Database,
  url: string,
  limit: number,
  cursor: StatusCursor = {},
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = cursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses
         WHERE card_url = ? AND kind = 'LocalNote' AND visibility = 'public' ${MODERATED_ACCOUNTS_SQL}
         ${where} ${order} LIMIT ?`,
      )
      .bind(url, ...binds, limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

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

export const extractHashtags = (text: string): string[] => {
  const tags = new Set<string>();
  for (const match of text.matchAll(/#([A-Za-z0-9_]+)/g)) {
    const tag = match[1];
    if (tag) {
      tags.add(tag.toLowerCase());
    }
  }
  return [...tags];
};

export const listTrendingTags = async (
  db: D1Database,
  limit: number,
  options: Readonly<{ excluded?: ReadonlySet<string>; offset?: number }> = {},
): Promise<Result<ReadonlyArray<{ name: string; uses: number }>, RepositoryError>> =>
  runD1(async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { results } = await db
      .prepare(
        `SELECT content_text FROM statuses
         WHERE kind = 'LocalNote' AND visibility = 'public' ${MODERATED_ACCOUNTS_SQL} ${SEARCHABLE_ACCOUNTS_SQL} AND created_at >= ?
         ORDER BY id DESC LIMIT 500`,
      )
      .bind(since)
      .all<{ content_text: string }>();
    const counts = new Map<string, number>();
    for (const row of results ?? []) {
      for (const tag of extractHashtags(row.content_text)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    const offset = options.offset ?? 0;
    return [...counts.entries()]
      .filter(([name]) => !options.excluded?.has(name))
      .map(([name, uses]) => ({ name, uses }))
      .toSorted((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
      .slice(offset, offset + limit);
  });

export const listTrendingStatuses = async (
  db: D1Database,
  limit: number,
  options: Readonly<{ includeRejected?: boolean; offset?: number }> = {},
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect},
            (SELECT COUNT(*) FROM favourites f WHERE f.status_id = statuses.id) AS favourite_count,
            (SELECT COUNT(*) FROM statuses r WHERE r.reblog_of_id = statuses.id) AS reblog_count
         FROM statuses
         WHERE kind = 'LocalNote' AND visibility = 'public' ${MODERATED_ACCOUNTS_SQL} ${SEARCHABLE_ACCOUNTS_SQL} AND created_at >= ?
           ${options.includeRejected ? "" : "AND statuses.id NOT IN (SELECT target FROM trend_reviews WHERE kind = 'Status' AND state = 'Rejected')"}
         ORDER BY (favourite_count + reblog_count) DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(since, limit, options.offset ?? 0)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

export const listDirectStatusesForAccount = async (
  db: D1Database,
  accountId: string,
  limit: number,
  maxId: string | undefined,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const suppressed = `AND account_id NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL}`;
    const sql = maxId
      ? `SELECT ${statusSelect} FROM statuses
         WHERE kind = 'LocalNote' AND visibility = 'direct'
           AND (account_id = ? OR id IN (SELECT status_id FROM status_mentions WHERE account_id = ?))
           ${suppressed}
           AND id < ?
         ORDER BY id DESC LIMIT ?`
      : `SELECT ${statusSelect} FROM statuses
         WHERE kind = 'LocalNote' AND visibility = 'direct'
           AND (account_id = ? OR id IN (SELECT status_id FROM status_mentions WHERE account_id = ?))
           ${suppressed}
         ORDER BY id DESC LIMIT ?`;
    const now = nowIso();
    const stmt = maxId
      ? db
          .prepare(sql)
          .bind(accountId, accountId, accountId, accountId, accountId, now, maxId, limit)
      : db.prepare(sql).bind(accountId, accountId, accountId, accountId, accountId, now, limit);
    const { results } = await stmt.all();
    return hydrateStatusRows(db, results ?? []);
  });

export const resolveDirectConversationRoot = async (
  db: D1Database,
  status: LocalStatusValue,
): Promise<Result<string, RepositoryError>> => {
  if (status.kind !== "LocalNote" || status.visibility.kind !== "Direct") {
    return ok(status.id);
  }
  let current: LocalStatusValue = status;
  for (let depth = 0; depth < CONTEXT_ANCESTOR_LIMIT; depth += 1) {
    if (current.kind !== "LocalNote" || !current.inReplyToId) {
      break;
    }
    const parent = await findStatusById(db, current.inReplyToId);
    if (parent.isErr()) {
      return err(parent.error);
    }
    if (
      !parent.value ||
      parent.value.kind !== "LocalNote" ||
      parent.value.visibility.kind !== "Direct"
    ) {
      break;
    }
    current = parent.value;
  }
  return ok(current.id);
};

/** Weekly status and registration counts; `week` is the Monday 00:00 UTC as UNIX seconds. */
export const listWeeklyStatusActivity = async (
  db: D1Database,
  weeks: number,
): Promise<
  Result<ReadonlyArray<{ week: string; statuses: number; registrations: number }>, RepositoryError>
> =>
  runD1(async () => {
    const { results: statusRows } = await db
      .prepare(
        `SELECT strftime('%s', date(created_at, '-6 days', 'weekday 1')) AS week, COUNT(*) AS statuses
         FROM statuses
         WHERE created_at >= datetime('now', ?)
         GROUP BY week
         ORDER BY week DESC
         LIMIT ?`,
      )
      .bind(`-${weeks * 7} days`, weeks)
      .all<{ week: string; statuses: number }>();
    const { results: registrationRows } = await db
      .prepare(
        `SELECT strftime('%s', date(created_at, '-6 days', 'weekday 1')) AS week, COUNT(*) AS registrations
         FROM accounts
         WHERE created_at >= datetime('now', ?)
         GROUP BY week`,
      )
      .bind(`-${weeks * 7} days`)
      .all<{ week: string; registrations: number }>();
    const registrations = new Map(
      (registrationRows ?? []).map((row) => [row.week, Number(row.registrations)]),
    );
    return (statusRows ?? []).map((row) => ({
      week: row.week,
      statuses: Number(row.statuses),
      registrations: registrations.get(row.week) ?? 0,
    }));
  });
