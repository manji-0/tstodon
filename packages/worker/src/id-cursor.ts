/** Mastodon's `max_id` / `since_id` / `min_id` id cursors. */
export type IdCursor = Readonly<{
  maxId?: string | undefined;
  sinceId?: string | undefined;
  minId?: string | undefined;
  /** Not a Mastodon cursor: the one entry with this id, for asking whether a timeline holds it. */
  onlyId?: string | undefined;
}>;

/**
 * Mastodon id cursors: `max_id` pages older (newest first), `since_id` pages
 * newer (newest first), and `min_id` pages newer from the oldest side so a
 * client can prepend. `min_id` wins, then `since_id`, then `max_id`.
 * Ids are exclusive bounds; `''` leaves a side open.
 */
export const idCursorBounds = (
  cursor: IdCursor = {},
): Readonly<{ onlyId: string; after: string; before: string; ascending: boolean }> => {
  const onlyId = cursor.onlyId ?? "";
  const minId = cursor.minId ?? "";
  const after = minId || (cursor.sinceId ?? "");
  return {
    onlyId,
    after,
    before: onlyId || after ? "" : (cursor.maxId ?? ""),
    ascending: minId.length > 0,
  };
};

/** The cursor as a SQL `where` / `order` pair over an `id` column, with its binds. */
export const idCursorFragment = (
  cursor: IdCursor = {},
): Readonly<{ where: string; order: string; binds: string[] }> => {
  const { onlyId, after, before, ascending } = idCursorBounds(cursor);
  if (onlyId.length > 0) {
    return { where: "AND id = ?", order: "", binds: [onlyId] };
  }
  if (after.length > 0) {
    return {
      where: "AND id > ?",
      order: ascending ? "ORDER BY id ASC" : "ORDER BY id DESC",
      binds: [after],
    };
  }
  if (before.length > 0) {
    return { where: "AND id < ?", order: "ORDER BY id DESC", binds: [before] };
  }
  return { where: "", order: "ORDER BY id DESC", binds: [] };
};
