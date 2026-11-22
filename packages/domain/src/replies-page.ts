import { z } from "zod";

/**
 * One page of a local note's `replies` collection, as Mastodon's
 * `RepliesController` serves it: the author's own replies, then those of
 * every other account, local or cached from another server, in one id
 * order. `afterId` is the id of the last reply of the page before (Mastodon's
 * `min_id`); without it the stage starts.
 */
const RepliesPageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SelfReplies"), afterId: z.string().min(1).optional() }),
  z.object({ kind: z.literal("OtherReplies"), afterId: z.string().min(1).optional() }),
]);

export type RepliesPage = z.infer<typeof RepliesPageSchema>;

/** The query of a page link, as Mastodon names it. */
export type RepliesPageQuery = Readonly<{
  only_other_accounts?: string | undefined;
  min_id?: string | undefined;
}>;

/** The strings Rails' `ActiveModel::Type::Boolean` casts to false. */
const FALSE_VALUES: ReadonlySet<string> = new Set(["0", "f", "F", "false", "FALSE", "off", "OFF"]);

const truthy = (value: string | undefined): boolean =>
  value !== undefined && value !== "" && !FALSE_VALUES.has(value);

export const RepliesPage = {
  schema: RepliesPageSchema,
  /** Replies per served page, Mastodon's `DESCENDANTS_LIMIT`. */
  LIMIT: 60,
  /** The author's own replies a note embeds in its first page, as Mastodon's `NoteSerializer`. */
  EMBEDDED_LIMIT: 5,
  /** The first page: the author's own replies. */
  first: { kind: "SelfReplies" } satisfies RepliesPage,
  /** A query flag as Mastodon's `truthy_param?` reads it. */
  truthy,
  fromQuery: (query: RepliesPageQuery): RepliesPage => ({
    kind: truthy(query.only_other_accounts) ? "OtherReplies" : "SelfReplies",
    ...(query.min_id ? { afterId: query.min_id } : {}),
  }),
  /** The query string of the link to `page`, with Mastodon's parameter names in Rails' order. */
  query: (page: RepliesPage): string => {
    const params = new URLSearchParams();
    if (page.afterId !== undefined) {
      params.set("min_id", page.afterId);
    }
    if (page.kind === "OtherReplies") {
      params.set("only_other_accounts", "true");
    }
    params.set("page", "true");
    return `?${params.toString()}`;
  },
  /**
   * The page after a served page of `page`'s stage that held `replyIds`,
   * read with `limit`: more of the stage when the page was full, else the
   * other accounts' replies; `undefined` after those.
   */
  next: (
    page: RepliesPage,
    replyIds: ReadonlyArray<string>,
    limit: number,
  ): RepliesPage | undefined => {
    const lastId = replyIds.at(-1);
    if (replyIds.length >= limit && lastId !== undefined) {
      return { kind: page.kind, afterId: lastId };
    }
    return page.kind === "SelfReplies" ? { kind: "OtherReplies" } : undefined;
  },
  /**
   * The page after a note's embedded first page that held `replyIds`, as
   * Mastodon's `NoteSerializer#replies`: the author's replies after the last
   * one, or the other accounts' when it held none.
   */
  embeddedNext: (replyIds: ReadonlyArray<string>): RepliesPage => {
    const lastId = replyIds.at(-1);
    return lastId === undefined
      ? { kind: "OtherReplies" }
      : { kind: "SelfReplies", afterId: lastId };
  },
} as const;
