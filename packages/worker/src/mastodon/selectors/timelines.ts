import { List as ImmutableList } from 'immutable';

import type { TimelineParams } from '../actions/timelines_typed';
import { timelineKey } from '../actions/timelines_typed';
import type { Timeline, TimelineItem } from '../models/timeline';
import { createAppSelector } from '../store';

interface TimelineShape {
  unread: number;
  online: boolean;
  top: boolean;
  isLoading: boolean;
  hasMore: boolean;
  pendingItems: ImmutableList<TimelineItem>;
  items: ImmutableList<TimelineItem>;
}

const emptyItems = ImmutableList<TimelineItem>();

export const selectTimelineByKey = createAppSelector(
  [(_, key: string) => key, (state) => state.timelines],
  (key, timelines) => toTypedTimeline(timelines.get(key)),
);

export const selectTimelineByParams = createAppSelector(
  [
    (_, params: TimelineParams) => timelineKey(params),
    (state) => state.timelines,
  ],
  (key, timelines) => toTypedTimeline(timelines.get(key)),
);

export const selectTimelinesByAccount = createAppSelector(
  [(state) => state.timelines, (_, accountId: string) => accountId],
  (timelines, accountId) =>
    timelines.filter((_, key) => key.startsWith(`account:${accountId}:`)),
);

export function toTypedTimeline(timeline?: Timeline): TimelineShape | null {
  if (!timeline) {
    return null;
  }
  return {
    unread: timeline.get('unread', 0),
    online: timeline.get('online', false),
    top: timeline.get('top', false),
    isLoading: timeline.get('isLoading', true),
    hasMore: timeline.get('hasMore', false),
    pendingItems: timeline.get('pendingItems', emptyItems),
    items: timeline.get('items', emptyItems),
  };
}
