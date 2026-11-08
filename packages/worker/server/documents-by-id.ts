/**
 * Rendered Mastodon documents keyed by their `id`. A document without a
 * string id has nothing to be looked up by and is left out; a later document
 * with the same id replaces an earlier one.
 */
export const documentsById = (
  documents: Iterable<Record<string, unknown>>,
): Map<string, Record<string, unknown>> =>
  new Map(
    [...documents].flatMap((document): [string, Record<string, unknown>][] =>
      typeof document.id === "string" ? [[document.id, document]] : [],
    ),
  );
