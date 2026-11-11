import { createReducer } from '@reduxjs/toolkit';
import {
  Map as ImmutableMap,
  List as ImmutableList,
  OrderedSet as ImmutableOrderedSet,
} from 'immutable';

import type { ApiRelationshipJSON } from 'mastodon/api_types/relationships';

import {
  blockAccountSuccess,
  muteAccountSuccess,
  unfollowAccountSuccess,
} from '../actions/accounts';
import {
  TIMELINE_UPDATE,
  TIMELINE_CLEAR,
  TIMELINE_EXPAND_SUCCESS,
  TIMELINE_EXPAND_REQUEST,
  TIMELINE_EXPAND_FAIL,
  TIMELINE_SCROLL_TOP,
  TIMELINE_CONNECT,
  TIMELINE_LOAD_PENDING,
  TIMELINE_MARK_AS_PARTIAL,
  TIMELINE_INSERT,
  TIMELINE_GAP,
  disconnectTimeline,
} from '../actions/timelines';
import type {
  TimelineClearAction,
  TimelineUpdateAction,
  connectTimeline,
  expandTimelineFail,
  expandTimelineRequest,
  expandTimelineSuccess,
  insertIntoTimeline,
  loadPending,
  markAsPartial,
  scrollTopTimeline,
} from '../actions/timelines';
import {
  timelineDelete,
  timelineDeleteStatus,
  isTimelineKeyPinned,
  isNonStatusId,
} from '../actions/timelines_typed';
import { compareId } from '../compare_id';

import type {
  Timeline,
  TimelineFields,
  TimelineItem,
  TimelineListKey,
  TimelinesState,
} from '../models/timeline';
import { immutableMapOf } from '../utils/immutable_map_of';

import { matchAction } from './match_action';
import type { StatusesState } from './statuses';

const isStatusId = (id: TimelineItem): id is string =>
  id !== null && !isNonStatusId(id);

const initialState: TimelinesState = ImmutableMap();

const initialTimeline: Timeline = immutableMapOf<TimelineFields>({
  unread: 0,
  online: false,
  top: true,
  isLoading: false,
  hasMore: true,
  pendingItems: ImmutableList<TimelineItem>(),
  items: ImmutableList<TimelineItem>(),
});

const updateItems = (
  timeline: Timeline,
  key: TimelineListKey,
  updater: (items: ImmutableList<TimelineItem>) => ImmutableList<TimelineItem>,
) => timeline.set(key, updater(timeline.get(key)));

/** The list of ids with a gap in front, unless it is empty or starts with one. */
const prependGap = (items: ImmutableList<TimelineItem>) =>
  items.first() ? items.unshift(TIMELINE_GAP) : items;

const expandNormalizedTimeline = (
  state: TimelinesState,
  timeline: string,
  newIds: ImmutableList<string>,
  next: string | null,
  isPartial: boolean,
  isLoadingRecent: boolean,
  usePendingItems: boolean | undefined,
) => {
  // This method is pretty tricky because:
  // - existing items in the timeline might be out of order
  // - the existing timeline may have gaps, most often explicitly noted with a `null` item
  // - ideally, we don't want it to reorder existing items of the timeline
  // - `statuses` may include items that are already included in the timeline
  // - this function can be called either to fill in a gap, or load newer items

  return state.update(timeline, initialTimeline, (map) =>
    map.withMutations((mMap) => {
      mMap.set('isLoading', false);
      mMap.set('isPartial', isPartial);

      if (!next && !isLoadingRecent) mMap.set('hasMore', false);

      const newest = newIds.first();
      const oldest = newIds.last();

      if (isTimelineKeyPinned(timeline)) {
        mMap.set('items', newIds);
      } else if (newest !== undefined && oldest !== undefined) {
        usePendingItems =
          isLoadingRecent &&
          (usePendingItems || !mMap.get('pendingItems').isEmpty());

        updateItems(
          mMap,
          usePendingItems ? 'pendingItems' : 'items',
          (oldIds) => {
            // Now this gets tricky, as we don't necessarily know for sure where the gap to fill is
            // and some items in the timeline may not be properly ordered.

            // However, we know that `newIds.last()` is the oldest item that was requested and that
            // there is no “hole” between `newIds.last()` and `newIds.first()`.

            // First, find the furthest (if properly sorted, oldest) item in the timeline that is
            // newer than the oldest fetched one, as it's most likely that it delimits the gap.
            // Start the gap *after* that item.
            const lastIndex =
              oldIds.findLastIndex(
                (id) => isStatusId(id) && compareId(id, oldest) >= 0,
              ) + 1;

            // Then, try to find the furthest (if properly sorted, oldest) item in the timeline that
            // is newer than the most recent fetched one, as it delimits a section comprised of only
            // items older or within `newIds` (or that were deleted from the server, so should be removed
            // anyway).
            // Stop the gap *after* that item.
            const firstIndex =
              oldIds
                .take(lastIndex)
                .findLastIndex(
                  (id) => isStatusId(id) && compareId(id, newest) > 0,
                ) + 1;

            let insertedIds = ImmutableOrderedSet<TimelineItem>(newIds)
              .withMutations((insertedIds) => {
                // It is possible, though unlikely, that the slice we are replacing contains items older
                // than the elements we got from the API. Get them and add them back at the back of the
                // slice.
                const olderIds = oldIds
                  .slice(firstIndex, lastIndex)
                  .filter((id) => isStatusId(id) && compareId(id, oldest) < 0);
                insertedIds.union(olderIds);

                // Make sure we aren't inserting duplicates
                insertedIds.subtract(
                  oldIds.take(firstIndex),
                  oldIds.skip(lastIndex),
                );
              })
              .toList();

            // Finally, insert a gap marker if the data is marked as partial by the server
            if (
              isPartial &&
              (firstIndex === 0 || oldIds.get(firstIndex - 1) !== TIMELINE_GAP)
            ) {
              insertedIds = insertedIds.unshift(TIMELINE_GAP);
            }

            return oldIds
              .take(firstIndex)
              .concat(insertedIds, oldIds.skip(lastIndex));
          },
        );
      }
    }),
  );
};

const updateTimeline = (
  state: TimelinesState,
  timeline: string,
  statusId: string,
  usePendingItems: boolean | undefined,
) => {
  const current = state.get(timeline);
  const top = current?.get('top');
  const ids = current?.get('items') ?? ImmutableList<TimelineItem>();
  const pendingIds =
    current?.get('pendingItems') ?? ImmutableList<TimelineItem>();

  if (usePendingItems || !pendingIds.isEmpty()) {
    if (pendingIds.includes(statusId) || ids.includes(statusId)) {
      return state;
    }

    return state.update(timeline, initialTimeline, (map) =>
      updateItems(map, 'pendingItems', (list) => list.unshift(statusId)).set(
        'unread',
        map.get('unread') + 1,
      ),
    );
  }

  const includesId = ids.includes(statusId);
  const unread = current?.get('unread') ?? 0;

  if (includesId) {
    return state;
  }

  let newIds = ids;

  return state.update(timeline, initialTimeline, (map) =>
    map.withMutations((mMap) => {
      if (!top) mMap.set('unread', unread + 1);
      if (top && ids.size > 40) newIds = newIds.take(20);
      mMap.set('items', newIds.unshift(statusId));
    }),
  );
};

const removeItem = (timeline: Timeline, id: string) => {
  const helper = (list: ImmutableList<TimelineItem>) =>
    list.filterNot((item) => item === id);
  return updateItems(
    updateItems(timeline, 'items', helper),
    'pendingItems',
    helper,
  );
};

/**
 * Removes the status and the given reblogs of it from every timeline, but
 * for the timelines of `excludeAccount` (blocking or muting an account
 * keeps its own statuses on its profile).
 */
const deleteStatus = (
  state: TimelinesState,
  id: string,
  references: string[],
  excludeAccount: string | null = null,
): TimelinesState => {
  state.keySeq().forEach((timeline) => {
    if (
      excludeAccount === null ||
      (timeline !== `account:${excludeAccount}` &&
        !timeline.startsWith(`account:${excludeAccount}:`))
    ) {
      state = state.update(timeline, initialTimeline, (map) =>
        removeItem(map, id),
      );
    }
  });

  // Remove reblogs of deleted status
  references.forEach((ref) => {
    state = deleteStatus(state, ref, [], excludeAccount);
  });

  return state;
};

const deleteStatusFromTimeline = (
  state: TimelinesState,
  statusId: string,
  timelineKey: string,
) => {
  const timeline = state.get(timelineKey);
  return timeline
    ? state.set(timelineKey, removeItem(timeline, statusId))
    : state;
};

const clearTimeline = (state: TimelinesState, timeline: string) => {
  return state.set(timeline, initialTimeline);
};

const filterTimelines = (
  state: TimelinesState,
  relationship: ApiRelationshipJSON,
  statuses: StatusesState,
) => {
  statuses.forEach((status) => {
    if (status.get('account') !== relationship.id) {
      return;
    }

    const references = statuses
      .filter((item) => item.get('reblog') === status.get('id'))
      .map((item) => item.get('id'))
      .valueSeq()
      .filter((id): id is string => typeof id === 'string')
      .toArray();
    state = deleteStatus(
      state,
      status.get('id') as string,
      references,
      relationship.id,
    );
  });

  return state;
};

const filterTimeline = (
  timeline: string,
  state: TimelinesState,
  relationship: ApiRelationshipJSON,
  statuses: StatusesState,
) => {
  const current = state.get(timeline);

  // Nothing to filter in a timeline that was not loaded.
  if (!current) {
    return state;
  }

  const helper = (list: ImmutableList<TimelineItem>) =>
    list.filterNot(
      (statusId) =>
        statusId !== null &&
        statuses.getIn([statusId, 'account']) === relationship.id,
    );
  return state.set(
    timeline,
    updateItems(updateItems(current, 'items', helper), 'pendingItems', helper),
  );
};

const updateTop = (state: TimelinesState, timeline: string, top: boolean) => {
  return state.update(timeline, initialTimeline, (map) =>
    map.withMutations((mMap) => {
      if (top) mMap.set('unread', mMap.get('pendingItems').size);
      mMap.set('top', top);
    }),
  );
};

const reconnectTimeline = (
  timeline: Timeline,
  usePendingItems: boolean | undefined,
) => {
  if (timeline.get('online')) {
    return timeline;
  }

  return timeline.withMutations((mMap) => {
    updateItems(mMap, usePendingItems ? 'pendingItems' : 'items', prependGap);
    mMap.set('online', true);
  });
};

const isLoadPending = matchAction<ReturnType<typeof loadPending>>(
  TIMELINE_LOAD_PENDING,
);
const isExpandRequest = matchAction<ReturnType<typeof expandTimelineRequest>>(
  TIMELINE_EXPAND_REQUEST,
);
const isExpandFail =
  matchAction<ReturnType<typeof expandTimelineFail>>(TIMELINE_EXPAND_FAIL);
const isExpandSuccess = matchAction<ReturnType<typeof expandTimelineSuccess>>(
  TIMELINE_EXPAND_SUCCESS,
);
const isUpdate = matchAction<TimelineUpdateAction>(TIMELINE_UPDATE);
const isClear = matchAction<TimelineClearAction>(TIMELINE_CLEAR);
const isScrollTop =
  matchAction<ReturnType<typeof scrollTopTimeline>>(TIMELINE_SCROLL_TOP);
const isConnect =
  matchAction<ReturnType<typeof connectTimeline>>(TIMELINE_CONNECT);
const isMarkAsPartial = matchAction<ReturnType<typeof markAsPartial>>(
  TIMELINE_MARK_AS_PARTIAL,
);
const isInsert =
  matchAction<ReturnType<typeof insertIntoTimeline>>(TIMELINE_INSERT);

const timelinesReducer = createReducer(initialState, (builder) => {
  builder
    .addCase(timelineDelete, (state, action) =>
      // `reblogOf` is a status id: no account's timelines are kept.
      deleteStatus(state, action.payload.statusId, action.payload.references),
    )
    .addCase(timelineDeleteStatus, (state, action) =>
      deleteStatusFromTimeline(
        state,
        action.payload.statusId,
        action.payload.timelineKey,
      ),
    )
    .addCase(blockAccountSuccess, (state, action) =>
      filterTimelines(
        state,
        action.payload.relationship,
        action.payload.statuses,
      ),
    )
    .addCase(muteAccountSuccess, (state, action) =>
      filterTimelines(
        state,
        action.payload.relationship,
        action.payload.statuses,
      ),
    )
    .addCase(unfollowAccountSuccess, (state, action) =>
      filterTimeline(
        'home',
        state,
        action.payload.relationship,
        action.payload.statuses,
      ),
    )
    .addCase(disconnectTimeline, (state, action) =>
      state.update(action.payload.timeline, initialTimeline, (map) =>
        updateItems(
          map.set('online', false),
          action.payload.usePendingItems ? 'pendingItems' : 'items',
          prependGap,
        ),
      ),
    )
    .addMatcher(isLoadPending, (state, action) =>
      state.update(action.timeline, initialTimeline, (map) =>
        updateItems(map, 'items', (list) =>
          map.get('pendingItems').concat(list.take(40)),
        )
          .set('pendingItems', ImmutableList())
          .set('unread', 0),
      ),
    )
    .addMatcher(isExpandRequest, (state, action) =>
      state.update(action.timeline, initialTimeline, (map) =>
        map.set('isLoading', true),
      ),
    )
    .addMatcher(isExpandFail, (state, action) =>
      state.update(action.timeline, initialTimeline, (map) =>
        map.set('isLoading', false),
      ),
    )
    .addMatcher(isExpandSuccess, (state, action) =>
      expandNormalizedTimeline(
        state,
        action.timeline,
        ImmutableList(action.statuses.map((status) => status.id)),
        action.next,
        action.partial,
        action.isLoadingRecent,
        action.usePendingItems,
      ),
    )
    .addMatcher(isUpdate, (state, action) =>
      updateTimeline(
        state,
        action.timeline,
        action.status.id,
        action.usePendingItems,
      ),
    )
    .addMatcher(isClear, (state, action) =>
      clearTimeline(state, action.timeline),
    )
    .addMatcher(isScrollTop, (state, action) =>
      updateTop(state, action.timeline, action.top),
    )
    .addMatcher(isConnect, (state, action) =>
      state.update(action.timeline, initialTimeline, (map) =>
        reconnectTimeline(map, action.usePendingItems),
      ),
    )
    .addMatcher(isMarkAsPartial, (state, action) =>
      state.update(action.timeline, initialTimeline, (map) =>
        map
          .set('isPartial', true)
          .set('items', ImmutableList())
          .set('pendingItems', ImmutableList())
          .set('unread', 0),
      ),
    )
    .addMatcher(isInsert, (state, action) =>
      state.update(action.timeline, initialTimeline, (map) =>
        updateItems(map, 'items', (list) => {
          if (!list.includes(action.key)) {
            return list.insert(action.index, action.key);
          }

          return list;
        }),
      ),
    );
});

export default timelinesReducer;
