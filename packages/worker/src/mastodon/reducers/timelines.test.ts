import { Map as ImmutableMap } from 'immutable';

import { relationshipsFactoryAPI, statusFactoryAPI } from '@/testing/factories';

import {
  blockAccountSuccess,
  unfollowAccountSuccess,
} from '../actions/accounts';
import { importStatuses } from '../actions/importer';
import { normalizeStatus } from '../actions/importer/normalizer';
import {
  TIMELINE_CLEAR,
  TIMELINE_GAP,
  TIMELINE_SUGGESTIONS,
  TIMELINE_UPDATE,
  connectTimeline,
  disconnectTimeline,
  expandTimelineFail,
  expandTimelineRequest,
  expandTimelineSuccess,
  insertIntoTimeline,
  loadPending,
  markAsPartial,
  scrollTopTimeline,
} from '../actions/timelines';
import type {
  TimelineClearAction,
  TimelineUpdateAction,
} from '../actions/timelines';
import {
  timelineDelete,
  timelineDeleteStatus,
} from '../actions/timelines_typed';
import { getTimelineItems } from '../models/timeline';
import type { TimelineListKey, TimelinesState } from '../models/timeline';

import statuses from './statuses';
import timelines from './timelines';

const apiStatuses = (...ids: string[]) =>
  ids.map((id) => statusFactoryAPI({ id }));

const expand = (
  state: TimelinesState | undefined,
  timeline: string,
  ids: string[],
  {
    next = 'https://example.com/next',
    partial = false,
    isLoadingRecent = false,
    usePendingItems = false,
  }: {
    next?: string | null;
    partial?: boolean;
    isLoadingRecent?: boolean;
    usePendingItems?: boolean;
  } = {},
) =>
  timelines(
    state,
    expandTimelineSuccess(
      timeline,
      apiStatuses(...ids),
      next,
      partial,
      isLoadingRecent,
      false,
      usePendingItems,
    ),
  );

const update = (
  state: TimelinesState,
  timeline: string,
  id: string,
  usePendingItems = false,
): TimelinesState =>
  timelines(state, {
    type: TIMELINE_UPDATE,
    timeline,
    status: statusFactoryAPI({ id }),
    usePendingItems,
  } satisfies TimelineUpdateAction);

const items = (
  state: TimelinesState,
  timeline: string,
  key: TimelineListKey = 'items',
) => getTimelineItems(state.get(timeline), key).toArray();

describe('timelines reducer', () => {
  test('starts empty', () => {
    expect(timelines(undefined, { type: 'INIT' })).toEqual(ImmutableMap());
  });

  test('creates a timeline on its first request, with the initial fields', () => {
    const state = timelines(undefined, expandTimelineRequest('home', false));
    expect(state.get('home')?.toJS()).toEqual({
      unread: 0,
      online: false,
      top: true,
      isLoading: true,
      hasMore: true,
      pendingItems: [],
      items: [],
    });

    expect(
      timelines(state, expandTimelineFail('home', new Error(), false)).getIn([
        'home',
        'isLoading',
      ]),
    ).toBe(false);
  });

  test('stores a loaded page, and the end of the timeline', () => {
    const state = expand(undefined, 'home', ['3', '2', '1'], { next: null });
    expect(items(state, 'home')).toEqual(['3', '2', '1']);
    expect(state.getIn(['home', 'isLoading'])).toBe(false);
    expect(state.getIn(['home', 'isPartial'])).toBe(false);
    expect(state.getIn(['home', 'hasMore'])).toBe(false);
  });

  test('appends an older page and prepends a newer one without duplicates', () => {
    let state = expand(undefined, 'home', ['5', '4', '3']);
    state = expand(state, 'home', ['3', '2', '1']);
    expect(items(state, 'home')).toEqual(['5', '4', '3', '2', '1']);

    state = expand(state, 'home', ['7', '6', '5'], { isLoadingRecent: true });
    expect(items(state, 'home')).toEqual(['7', '6', '5', '4', '3', '2', '1']);
  });

  test('fills a gap', () => {
    let state = expand(undefined, 'home', ['9', '8']);
    state = timelines(state, disconnectTimeline({ timeline: 'home' }));
    state = timelines(state, connectTimeline('home'));
    state = expand(state, 'home', ['3', '2']);
    expect(items(state, 'home')).toEqual([TIMELINE_GAP, '9', '8', '3', '2']);

    // The page above the gap ends at a status the timeline has.
    state = expand(state, 'home', ['11', '10', '9']);
    expect(items(state, 'home')).toEqual(['11', '10', '9', '8', '3', '2']);
  });

  test('marks a partial page with a gap', () => {
    const state = expand(undefined, 'home', ['2', '1'], { partial: true });
    expect(items(state, 'home')).toEqual([TIMELINE_GAP, '2', '1']);
    expect(state.getIn(['home', 'isPartial'])).toBe(true);
  });

  test('replaces a pinned timeline', () => {
    let state = expand(undefined, 'account:1:0001', ['2', '1']);
    state = expand(state, 'account:1:0001', ['3']);
    expect(items(state, 'account:1:0001')).toEqual(['3']);
  });

  test('puts a streamed status on top, or counts it unread when scrolled', () => {
    let state = expand(undefined, 'home', ['1']);
    state = update(state, 'home', '2');
    expect(items(state, 'home')).toEqual(['2', '1']);
    expect(state.getIn(['home', 'unread'])).toBe(0);

    state = timelines(state, scrollTopTimeline('home', false));
    state = update(state, 'home', '3');
    state = update(state, 'home', '3');
    expect(items(state, 'home')).toEqual(['3', '2', '1']);
    expect(state.getIn(['home', 'unread'])).toBe(1);
  });

  test('keeps streamed statuses pending until they are loaded', () => {
    let state = expand(undefined, 'home', ['1']);
    state = update(state, 'home', '2', true);
    state = update(state, 'home', '3');
    expect(items(state, 'home', 'pendingItems')).toEqual(['3', '2']);
    expect(state.getIn(['home', 'unread'])).toBe(2);

    state = timelines(state, loadPending('home'));
    expect(items(state, 'home')).toEqual(['3', '2', '1']);
    expect(items(state, 'home', 'pendingItems')).toEqual([]);
    expect(state.getIn(['home', 'unread'])).toBe(0);
  });

  test('creates a timeline a status is streamed to before it loads', () => {
    const state = update(timelines(undefined, { type: 'INIT' }), 'list:1', '1');
    expect(items(state, 'list:1')).toEqual(['1']);
    expect(state.getIn(['list:1', 'unread'])).toBe(1);
  });

  test('counts the pending statuses unread when scrolled to the top', () => {
    let state = expand(undefined, 'home', ['1']);
    state = update(state, 'home', '2', true);
    state = timelines(state, scrollTopTimeline('home', false));
    state = timelines(state, scrollTopTimeline('home', true));
    expect(state.getIn(['home', 'unread'])).toBe(1);
    expect(state.getIn(['home', 'top'])).toBe(true);
  });

  test('clears, and marks a timeline as partial', () => {
    let state = expand(undefined, 'home', ['1']);
    state = timelines(state, markAsPartial('home'));
    expect(items(state, 'home')).toEqual([]);
    expect(state.getIn(['home', 'isPartial'])).toBe(true);

    state = timelines(state, {
      type: TIMELINE_CLEAR,
      timeline: 'home',
    } satisfies TimelineClearAction);
    expect(state.getIn(['home', 'isPartial'])).toBeUndefined();
    expect(state.getIn(['home', 'hasMore'])).toBe(true);
  });

  test('inserts a marker once', () => {
    let state = expand(undefined, 'home', ['2', '1']);
    state = timelines(
      state,
      insertIntoTimeline('home', TIMELINE_SUGGESTIONS, 1),
    );
    state = timelines(
      state,
      insertIntoTimeline('home', TIMELINE_SUGGESTIONS, 2),
    );
    expect(items(state, 'home')).toEqual(['2', TIMELINE_SUGGESTIONS, '1']);
  });

  test('deletes a status and its reblogs from every timeline', () => {
    let state = expand(undefined, 'home', ['3', '2', '1']);
    state = expand(state, 'account:9:0000', ['2']);
    state = timelines(
      state,
      timelineDelete({
        statusId: '2',
        accountId: '9',
        references: ['3'],
        reblogOf: null,
      }),
    );
    expect(items(state, 'home')).toEqual(['1']);
    expect(items(state, 'account:9:0000')).toEqual([]);
  });

  test('deletes a status from one timeline', () => {
    let state = expand(undefined, 'home', ['2', '1']);
    state = timelines(
      state,
      timelineDeleteStatus({ statusId: '2', timelineKey: 'home' }),
    );
    expect(items(state, 'home')).toEqual(['1']);
    expect(
      timelines(
        state,
        timelineDeleteStatus({ statusId: '1', timelineKey: 'missing' }),
      ),
    ).toBe(state);
  });

  describe('blocking and unfollowing an account', () => {
    const storedStatuses = statuses(
      undefined,
      importStatuses(
        [
          statusFactoryAPI({ id: '1' }),
          statusFactoryAPI({ id: '2' }),
          statusFactoryAPI({ id: '3' }),
        ].map((status, index) =>
          normalizeStatus(
            {
              ...status,
              account: { ...status.account, id: index === 1 ? 'b' : 'a' },
            },
            undefined,
            {},
          ),
        ),
      ),
    );

    test('removes its statuses but from its own timelines', () => {
      let state = expand(undefined, 'home', ['3', '2', '1']);
      state = expand(state, 'account:b:0000', ['2']);
      state = timelines(
        state,
        blockAccountSuccess({
          relationship: relationshipsFactoryAPI({ id: 'b', blocking: true }),
          statuses: storedStatuses,
        }),
      );
      expect(items(state, 'home')).toEqual(['3', '1']);
      expect(items(state, 'account:b:0000')).toEqual(['2']);
    });

    test('removes its statuses from the home timeline', () => {
      let state = expand(undefined, 'home', ['3', '2', '1']);
      state = expand(state, 'public', ['2']);
      state = timelines(
        state,
        unfollowAccountSuccess({
          relationship: relationshipsFactoryAPI({ id: 'b' }),
          statuses: storedStatuses,
        }),
      );
      expect(items(state, 'home')).toEqual(['3', '1']);
      expect(items(state, 'public')).toEqual(['2']);
    });

    test('does not create the home timeline', () => {
      const state = expand(undefined, 'public', ['2']);
      expect(
        timelines(
          state,
          unfollowAccountSuccess({
            relationship: relationshipsFactoryAPI({ id: 'b' }),
            statuses: storedStatuses,
          }),
        ),
      ).toBe(state);
    });
  });
});
