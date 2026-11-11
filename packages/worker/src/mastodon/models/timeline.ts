import type { List as ImmutableList, Map as ImmutableMap } from 'immutable';

import type { ImmutableMapOf } from '../utils/immutable_map_of';

/**
 * An item of a timeline: a status id, `null` for a gap (`TIMELINE_GAP`), or
 * a marker (`TIMELINE_SUGGESTIONS`, `TIMELINE_PINNED_VIEW_ALL`).
 */
export type TimelineItem = string | null;

/** The fields of a timeline (`isPartial` once a page has been loaded). */
export interface TimelineFields {
  unread: number;
  online: boolean;
  top: boolean;
  isLoading: boolean;
  hasMore: boolean;
  isPartial?: boolean;
  pendingItems: ImmutableList<TimelineItem>;
  items: ImmutableList<TimelineItem>;
}

/** A timeline (`reducers/timelines.ts`): an Immutable `Map` of `TimelineFields`. */
export type Timeline = ImmutableMapOf<TimelineFields>;

/** The timelines by key (`home`, `account:<id>:<flags>`, `hashtag:<tag>`, ...). */
export type TimelinesState = ImmutableMap<string, Timeline>;

export type TimelineListKey = 'items' | 'pendingItems';
