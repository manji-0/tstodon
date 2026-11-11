import type { OrderedSet as ImmutableOrderedSet } from 'immutable';

import type { ImmutableMapOf } from '../utils/immutable_map_of';

/**
 * The fields of a status list (`reducers/status_lists.ts`): its status ids
 * and the URL of its next page (`isLoading` once it has been requested;
 * `statusId`, the quoted status, on `quotes` only).
 */
export interface StatusListFields {
  next: string | null;
  loaded: boolean;
  isLoading?: boolean;
  items: ImmutableOrderedSet<string>;
  statusId?: string | null;
}

/** A status list: an Immutable `Map` of `StatusListFields`. */
export type StatusList = ImmutableMapOf<StatusListFields>;

export type StatusListKey =
  | 'favourites'
  | 'bookmarks'
  | 'pins'
  | 'trending'
  | 'quotes';

/** The status lists, each of them always there. */
export type StatusListsState = ImmutableMapOf<Record<StatusListKey, StatusList>>;
