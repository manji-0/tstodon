import { entityIdInstant, firstEntityIdAt, nextEntityId } from "./ids";

/** Mastodon's `max_id` / `since_id` / `min_id` id cursors. */
export type IdCursor = Readonly<{
  maxId?: string | undefined;
  sinceId?: string | undefined;
  minId?: string | undefined;
  /** Not a Mastodon cursor: the one entry with this id, for asking whether a timeline holds it. */
  onlyId?: string | undefined;
}>;

/**
 * The cursors of Mastodon's `paginate_by_max_id`, for a list that reads no
 * `min_id`: newest first, below `max_id` and above `since_id`.
 */
export type MaxIdCursor = Readonly<{ maxId?: string | undefined; sinceId?: string | undefined }>;

/**
 * Mastodon id cursors, as `Paginable#to_a_paginated_by_id`: `max_id` bounds
 * the page above, and `since_id` (newest first) or `min_id` (from the oldest
 * side, so a client can prepend) below; `min_id` wins over `since_id`, and
 * `max_id` holds with either. Ids are exclusive bounds; `''` leaves a side
 * open.
 */
export const idCursorBounds = (
  cursor: IdCursor = {},
): Readonly<{ onlyId: string; after: string; before: string; ascending: boolean }> => {
  const onlyId = cursor.onlyId ?? "";
  const minId = cursor.minId ?? "";
  return {
    onlyId,
    after: onlyId ? "" : minId || (cursor.sinceId ?? ""),
    before: onlyId ? "" : (cursor.maxId ?? ""),
    ascending: minId.length > 0,
  };
};

/**
 * A page read by `cursor`, newest first: a `min_id` page is read oldest first
 * and answered reversed, as Mastodon's `to_a_paginated_by_id` does.
 */
export const newestFirst = <T>(cursor: IdCursor, page: ReadonlyArray<T>): T[] =>
  idCursorBounds(cursor).ascending ? page.toReversed() : [...page];

/**
 * A page of `entries` held in their own order, as an id-paged query reads
 * them: the first `limit` within the cursor's bounds, or for a `min_id` page
 * the `limit` lowest ids, answered newest first.
 */
export const pageInOrder = <T extends Readonly<{ id: string }>>(
  entries: ReadonlyArray<T>,
  cursor: IdCursor,
  limit: number,
): T[] => {
  const { onlyId, after, before, ascending } = idCursorBounds(cursor);
  const within = entries.filter((entry) =>
    onlyId.length > 0
      ? entry.id === onlyId
      : (after.length === 0 || entry.id > after) && (before.length === 0 || entry.id < before),
  );
  return ascending
    ? within
        .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .slice(0, limit)
        .toReversed()
    : within.slice(0, limit);
};

/**
 * The cursor as a SQL `where` / `order` pair over the status id `column`
 * (`id` unless a join drives from another table's copy of it), with its binds.
 */
export const idCursorFragment = (
  cursor: IdCursor = {},
  column = "id",
): Readonly<{ where: string; order: string; binds: string[] }> => {
  const { onlyId, after, before, ascending } = idCursorBounds(cursor);
  if (onlyId.length > 0) {
    return { where: `AND ${column} = ?`, order: "", binds: [onlyId] };
  }
  const bounds = [
    ...(after.length > 0 ? [{ sql: `AND ${column} > ?`, bind: after }] : []),
    ...(before.length > 0 ? [{ sql: `AND ${column} < ?`, bind: before }] : []),
  ];
  return {
    where: bounds.map((bound) => bound.sql).join(" "),
    order: `ORDER BY ${column} ${ascending ? "ASC" : "DESC"}`,
    binds: bounds.map((bound) => bound.bind),
  };
};

/**
 * How far back from its top a followed feed's page (home, a list) reads in
 * each step, the last step down to the cursor's other bound. Its query seeks
 * each followed author's statuses by index, so a page read in one step reads
 * every status they wrote above it (home: 81,671 rows for a page of 20 on
 * `pnpm bench`'s data) or, with a LIMIT per author, up to a page's worth
 * from each (a list). A step reads only its window, and the next one only
 * what the page still lacks, below it. See
 * `docs/architecture/d1-heavy-scenarios.md#benchmark`.
 */
export const FEED_PAGE_WINDOWS_MS: ReadonlyArray<number | undefined> = [
  6 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  undefined,
];

/**
 * The rows `read` gives for a page of `limit` within `cursor`, read back from
 * the page's top in {@link FEED_PAGE_WINDOWS_MS} steps. A page with no top is
 * read in one step: a `min_id` page (read oldest first), the one-entry check,
 * or a `max_id` that is no entity id.
 */
export const readPageInWindows = async <Row>(
  cursor: IdCursor,
  limit: number,
  read: (limit: number, cursor: IdCursor) => Promise<ReadonlyArray<Row>>,
): Promise<Row[]> => {
  const { onlyId, after, before, ascending } = idCursorBounds(cursor);
  const top =
    onlyId.length > 0 || ascending
      ? undefined
      : before.length > 0
        ? entityIdInstant(before)
        : Date.now();
  if (top === undefined) {
    return [...(await read(limit, cursor))];
  }
  const rows: Row[] = [];
  let ceiling = before;
  for (const windowMs of FEED_PAGE_WINDOWS_MS) {
    const windowFloor = windowMs === undefined ? "" : firstEntityIdAt(top - windowMs);
    const floor = after > windowFloor ? after : windowFloor;
    rows.push(...(await read(limit - rows.length, { maxId: ceiling, sinceId: floor })));
    if (rows.length >= limit || floor === after) {
      break;
    }
    ceiling = nextEntityId(floor);
  }
  return rows;
};
