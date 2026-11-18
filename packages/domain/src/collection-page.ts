import { z } from "zod";

/** An item id a page link carries: tstodon's ids are decimal strings. */
const CursorIdSchema = z.string().regex(/^\d{1,20}$/);

/**
 * Where a page of a local actor collection (followers, following, outbox)
 * starts: at the newest item, below `id` (Mastodon's `max_id`), or just above
 * `id` (`min_id`, the page that ends nearest to it).
 */
const CollectionCursorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Newest") }),
  z.object({ kind: z.literal("Before"), id: CursorIdSchema }),
  z.object({ kind: z.literal("After"), id: CursorIdSchema }),
]);

export type CollectionCursor = z.infer<typeof CollectionCursorSchema>;

/** A GET of a collection: the collection itself (its count and links), or one page of it. */
export type CollectionRequest =
  | Readonly<{ kind: "Root" }>
  | Readonly<{ kind: "Page"; cursor: CollectionCursor }>;

/** The query of a collection GET, with Mastodon's parameter names. */
const CollectionQuerySchema = z.object({
  page: z.string().optional(),
  max_id: CursorIdSchema.optional(),
  min_id: CursorIdSchema.optional(),
});

export type CollectionQuery = z.infer<typeof CollectionQuerySchema>;

/** The links of a page to the pages next to it; absent when there is none. */
export type CollectionPageLinks = Readonly<{
  next?: CollectionCursor;
  prev?: CollectionCursor;
}>;

/** Rails' `ActiveModel::Type::Boolean` false values, which `truthy_param?` rejects. */
const FALSE_VALUES = new Set(["", "0", "f", "false", "off"]);

const cursorOf = (query: CollectionQuery): CollectionCursor => {
  if (query.min_id !== undefined) {
    return { kind: "After", id: query.min_id };
  }
  if (query.max_id !== undefined) {
    return { kind: "Before", id: query.max_id };
  }
  return { kind: "Newest" };
};

export const CollectionPage = {
  querySchema: CollectionQuerySchema,
  /** Follows per page, Mastodon's `FOLLOW_PER_PAGE`. */
  FOLLOWS_LIMIT: 12,
  /** Statuses per outbox page, `ActivityPub::OutboxesController::LIMIT`. */
  OUTBOX_LIMIT: 20,
  /**
   * The request a query makes. The follow collections page on any non-blank
   * `page` (`params[:page].present?`), the outbox on a true one
   * (`truthy_param?(:page)`).
   */
  fromQuery: (query: CollectionQuery, page: "Present" | "Truthy"): CollectionRequest => {
    const value = query.page?.trim();
    const requested =
      value !== undefined &&
      value.length > 0 &&
      (page === "Present" || !FALSE_VALUES.has(value.toLowerCase()));
    return requested ? { kind: "Page", cursor: cursorOf(query) } : { kind: "Root" };
  },
  /**
   * The query string of the page at `cursor` (keys sorted, as Rails' `to_query`
   * writes them). `page` is the value of the `page` parameter.
   */
  query: (cursor: CollectionCursor, page = "true"): string => {
    const params = new URLSearchParams();
    if (cursor.kind === "Before") {
      params.set("max_id", cursor.id);
    }
    if (cursor.kind === "After") {
      params.set("min_id", cursor.id);
    }
    params.set("page", page);
    return `?${params.toString()}`;
  },
  /**
   * A page out of the rows read for it: at most `limit`, newest first. Rows
   * are read newest first, except after an `After` cursor, where they are
   * read oldest first. `more` says whether a row lay past the page in the
   * read's direction (read `limit + 1` rows to know).
   */
  take: <Row>(
    cursor: CollectionCursor,
    rows: ReadonlyArray<Row>,
    limit: number,
  ): Readonly<{ items: Row[]; more: boolean }> => {
    const items = rows.slice(0, limit);
    return {
      items: cursor.kind === "After" ? items.reverse() : items,
      more: rows.length > limit,
    };
  },
  /**
   * The links of a followers or following page holding `ids`, newest first.
   * Mastodon numbers these pages and links a page before and after only
   * where one exists; tstodon links by id, so a walk does not skip or repeat
   * a follow made meanwhile, and keeps that rule: `next` only when an older
   * follow remains, `prev` only off the first page and when a newer one does.
   */
  followsLinks: (
    cursor: CollectionCursor,
    ids: ReadonlyArray<string>,
    more: boolean,
  ): CollectionPageLinks => {
    const newest = ids.at(0);
    const oldest = ids.at(-1);
    if (newest === undefined || oldest === undefined) {
      return {};
    }
    const olderRemain = cursor.kind === "After" || more;
    const newerRemain = cursor.kind === "Before" || (cursor.kind === "After" && more);
    return {
      ...(olderRemain ? { next: { kind: "Before", id: oldest } } : {}),
      ...(newerRemain ? { prev: { kind: "After", id: newest } } : {}),
    };
  },
  /**
   * The links of an outbox page holding `ids`, newest first, as Mastodon's
   * `OutboxesController`: `next` when the page is full, `prev` when it is
   * not empty.
   */
  outboxLinks: (ids: ReadonlyArray<string>, limit: number): CollectionPageLinks => {
    const newest = ids.at(0);
    const oldest = ids.at(-1);
    if (newest === undefined || oldest === undefined) {
      return {};
    }
    return {
      ...(ids.length >= limit ? { next: { kind: "Before", id: oldest } } : {}),
      prev: { kind: "After", id: newest },
    };
  },
} as const;
