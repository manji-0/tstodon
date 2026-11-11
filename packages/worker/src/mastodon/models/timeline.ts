import type { Map as ImmutableMap } from 'immutable';
import { List as ImmutableList } from 'immutable';

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
  isPartial: boolean;
  pendingItems: ImmutableList<TimelineItem>;
  items: ImmutableList<TimelineItem>;
}

/**
 * A timeline (`reducers/timelines.ts`): an Immutable `Map` of
 * `TimelineFields`. Immutable 4 types a `Map` with one value type, so a
 * field is read with the helpers below.
 */
export type Timeline = ImmutableMap<
  keyof TimelineFields,
  TimelineFields[keyof TimelineFields]
>;

/** The timelines by key (`home`, `account:<id>:<flags>`, `hashtag:<tag>`, ...). */
export type TimelinesState = ImmutableMap<string, Timeline>;

export type TimelineListKey = 'items' | 'pendingItems';
export type TimelineFlagKey =
  | 'online'
  | 'top'
  | 'isLoading'
  | 'hasMore'
  | 'isPartial';

const emptyItems = ImmutableList<TimelineItem>();

/** A timeline's `items` or `pendingItems`, empty for a missing timeline. */
export const getTimelineItems = (
  timeline: Timeline | undefined,
  key: TimelineListKey = 'items',
): ImmutableList<TimelineItem> => {
  const items = timeline?.get(key);
  return ImmutableList.isList(items) ? items : emptyItems;
};

/** A timeline's flag, `undefined` when it is not set. */
export const getTimelineFlag = (
  timeline: Timeline | undefined,
  key: TimelineFlagKey,
): boolean | undefined => {
  const flag = timeline?.get(key);
  return typeof flag === 'boolean' ? flag : undefined;
};

/** A timeline's unread count, 0 when it is not set. */
export const getTimelineUnread = (timeline: Timeline | undefined): number => {
  const unread = timeline?.get('unread');
  return typeof unread === 'number' ? unread : 0;
};
