/**
 * Rendered Mastodon documents keyed by their `id`; a later document with the
 * same id replaces an earlier one.
 */
export const documentsById = <T extends Readonly<{ id: string }>>(
  documents: Iterable<T>,
): Map<string, T> =>
  new Map([...documents].map((document): [string, T] => [document.id, document]));
