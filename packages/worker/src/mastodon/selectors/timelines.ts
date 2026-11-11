import type { List as ImmutableList } from 'immutable';

import type { TimelineParams } from '../actions/timelines_typed';
import { timelineKey } from '../actions/timelines_typed';
import {
  getTimelineFlag,
  getTimelineItems,
  getTimelineUnread,
} from '../models/timeline';
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
    unread: getTimelineUnread(timeline),
    online: getTimelineFlag(timeline, 'online') ?? false,
    top: getTimelineFlag(timeline, 'top') ?? false,
    isLoading: getTimelineFlag(timeline, 'isLoading') ?? true,
    hasMore: getTimelineFlag(timeline, 'hasMore') ?? false,
    pendingItems: getTimelineItems(timeline, 'pendingItems'),
    items: getTimelineItems(timeline, 'items'),
  };
}
