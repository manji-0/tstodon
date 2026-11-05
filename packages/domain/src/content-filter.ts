/** A viewer's filter as matching sees it (Mastodon's v2 filter). */
export type ContentFilter = Readonly<{
  /** Mastodon's `home` / `notifications` / `public` / `thread` / `account`. */
  contexts: ReadonlyArray<string>;
  expiresAt: string | null;
  keywords: ReadonlyArray<Readonly<{ keyword: string; wholeWord: boolean }>>;
  /** The statuses the filter is narrowed to. */
  statusIds: ReadonlyArray<string>;
}>;

/** What one piece of content is, where it is shown. */
export type FilteredContent = Readonly<{
  context: string;
  text: string;
  statusId: string | null;
}>;

/** Mastodon's `keyword_matches` and `status_matches` of a matching filter. */
export type ContentFilterMatch = Readonly<{
  keywordMatches: ReadonlyArray<string>;
  statusMatches: ReadonlyArray<string>;
}>;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const keywordHits = (keyword: string, wholeWord: boolean, text: string): boolean => {
  const needle = keyword.toLowerCase();
  if (!wholeWord) {
    return text.toLowerCase().includes(needle);
  }
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(needle)}(?:$|[^\\p{L}\\p{N}_])`,
    "iu",
  ).test(text);
};

export const ContentFilter = {
  /**
   * How the filter matches the content: when one of its keywords appears in
   * the text, or it is narrowed to this status. `undefined` when it does not
   * match, has expired by `now` (epoch milliseconds), or does not apply to
   * the content's context.
   */
  match: (
    filter: ContentFilter,
    content: FilteredContent,
    now: number,
  ): ContentFilterMatch | undefined => {
    if (filter.expiresAt !== null && Date.parse(filter.expiresAt) <= now) {
      return undefined;
    }
    if (!filter.contexts.includes(content.context)) {
      return undefined;
    }
    const statusId = content.statusId;
    const statusMatches =
      statusId !== null && filter.statusIds.includes(statusId) ? [statusId] : [];
    const keywordMatches = filter.keywords
      .filter((keyword) => keywordHits(keyword.keyword, keyword.wholeWord, content.text))
      .map((keyword) => keyword.keyword);
    return keywordMatches.length === 0 && statusMatches.length === 0
      ? undefined
      : { keywordMatches, statusMatches };
  },
} as const;
