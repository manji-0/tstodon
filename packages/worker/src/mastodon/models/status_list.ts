import type { Map as ImmutableMap } from 'immutable';
import { OrderedSet as ImmutableOrderedSet } from 'immutable';

/**
 * The fields of a status list (`reducers/status_lists.ts`): its status ids
 * and the URL of its next page (`isLoading` once it has been requested;
 * `statusId`, the quoted status, on `quotes` only).
 */
export interface StatusListFields {
  next: string | null;
  loaded: boolean;
  isLoading: boolean;
  items: ImmutableOrderedSet<string>;
  statusId: string | null;
}

/** A status list: an Immutable `Map` of `StatusListFields`. */
export type StatusList = ImmutableMap<
  keyof StatusListFields,
  StatusListFields[keyof StatusListFields]
>;

export type StatusListKey =
  | 'favourites'
  | 'bookmarks'
  | 'pins'
  | 'trending'
  | 'quotes';

export type StatusListsState = ImmutableMap<StatusListKey, StatusList>;

const emptyItems = ImmutableOrderedSet<string>();

/** A status list's ids, empty for a missing list. */
export const getStatusListItems = (
  list: StatusList | undefined,
): ImmutableOrderedSet<string> => {
  const items = list?.get('items');
  return ImmutableOrderedSet.isOrderedSet(items) ? items : emptyItems;
};
