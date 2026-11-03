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
 */
export const idCursorFragment = (
  cursor: IdCursor = {},
): Readonly<{ where: string; order: string; binds: string[] }> => {
  const onlyId = cursor.onlyId ?? "";
  if (onlyId.length > 0) {
    return { where: "AND id = ?", order: "", binds: [onlyId] };
  }
  const minId = cursor.minId ?? "";
  if (minId.length > 0) {
    return { where: "AND id > ?", order: "ORDER BY id ASC", binds: [minId] };
  }
  const sinceId = cursor.sinceId ?? "";
  if (sinceId.length > 0) {
    return { where: "AND id > ?", order: "ORDER BY id DESC", binds: [sinceId] };
  }
  const maxId = cursor.maxId ?? "";
  if (maxId.length > 0) {
    return { where: "AND id < ?", order: "ORDER BY id DESC", binds: [maxId] };
  }
  return { where: "", order: "ORDER BY id DESC", binds: [] };
};
