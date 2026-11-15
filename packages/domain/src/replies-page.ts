import { z } from "zod";

/**
 * One page of a local note's `replies` collection. The pages run in three
 * stages, as Mastodon's `RepliesController` runs two: the author's own
 * replies, then the replies of other local accounts, then the replies cached
 * from other servers (Mastodon keeps both in one table and lists them
 * together). `afterId` is the id of the last reply of the page before, in the
 * stage's own id order; without it the stage starts.
 */
const RepliesPageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SelfReplies"), afterId: z.string().min(1).optional() }),
  z.object({ kind: z.literal("LocalReplies"), afterId: z.string().min(1).optional() }),
  z.object({ kind: z.literal("RemoteReplies"), afterId: z.string().min(1).optional() }),
]);

export type RepliesPage = z.infer<typeof RepliesPageSchema>;

/** The query of a page link, as Mastodon names it, plus `remote` for the third stage. */
export type RepliesPageQuery = Readonly<{
  only_other_accounts?: string | undefined;
  remote?: string | undefined;
  min_id?: string | undefined;
}>;

const truthy = (value: string | undefined): boolean =>
  value !== undefined && ["1", "true", "t", "yes", "on"].includes(value.toLowerCase());

/** The stage after `kind`, when its replies are exhausted. */
const stageAfter = (kind: RepliesPage["kind"]): RepliesPage | undefined => {
  switch (kind) {
    case "SelfReplies":
      return { kind: "LocalReplies" };
    case "LocalReplies":
      return { kind: "RemoteReplies" };
    case "RemoteReplies":
      return undefined;
  }
};

export const RepliesPage = {
  schema: RepliesPageSchema,
  /** Replies per served page, Mastodon's `DESCENDANTS_LIMIT`. */
  LIMIT: 60,
  /** The author's own replies a note embeds in its first page, as Mastodon's `NoteSerializer`. */
  EMBEDDED_LIMIT: 5,
  /** The first page: the author's own replies. */
  first: { kind: "SelfReplies" } satisfies RepliesPage,
  fromQuery: (query: RepliesPageQuery): RepliesPage => {
    const after = query.min_id ? { afterId: query.min_id } : {};
    if (!truthy(query.only_other_accounts)) {
      return { kind: "SelfReplies", ...after };
    }
    return { kind: truthy(query.remote) ? "RemoteReplies" : "LocalReplies", ...after };
  },
  /** The query string of the link to `page`, with Mastodon's parameter names. */
  query: (page: RepliesPage): string => {
    const params = new URLSearchParams();
    if (page.afterId !== undefined) {
      params.set("min_id", page.afterId);
    }
    if (page.kind !== "SelfReplies") {
      params.set("only_other_accounts", "true");
    }
    if (page.kind === "RemoteReplies") {
      params.set("remote", "true");
    }
    params.set("page", "true");
    return `?${params.toString()}`;
  },
  /**
   * The page after one of `page`'s stage that held `replyIds`, read with
   * `limit`: more of the stage when the page was full, else the next stage;
   * `undefined` after the last one.
   */
  next: (
    page: RepliesPage,
    replyIds: ReadonlyArray<string>,
    limit: number,
  ): RepliesPage | undefined => {
    const lastId = replyIds.at(-1);
    return replyIds.length >= limit && lastId !== undefined
      ? { kind: page.kind, afterId: lastId }
      : stageAfter(page.kind);
  },
} as const;
