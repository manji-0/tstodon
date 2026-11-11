import type {
  ApiGetAccountStatusesParams,
  ApiGetHomeTimelineParams,
  ApiGetLinkTimelineParams,
  ApiGetListTimelineParams,
  ApiGetPublicTimelineParams,
  ApiGetTagTimelineParams,
} from '@tstodon/api';
import { apiFetchTimeline } from 'mastodon/api/timelines';
import type { ApiTimelineParams } from 'mastodon/api/timelines';
import type { ApiStatusJSON } from 'mastodon/api_types/statuses';
import { compareId } from 'mastodon/compare_id';
import { usePendingItems as preferPendingItems } from 'mastodon/initial_state';
import type { Timeline, TimelineListKey } from 'mastodon/models/timeline';
import type { AppDispatch, GetState } from 'mastodon/store';

import { importFetchedStatus, importFetchedStatuses } from './importer';
import { submitMarkers } from './markers';
import { isNonStatusId, timelineDelete } from './timelines_typed';

export { disconnectTimeline } from './timelines_typed';

export const TIMELINE_UPDATE  = 'TIMELINE_UPDATE' as const;
export const TIMELINE_CLEAR   = 'TIMELINE_CLEAR' as const;

export const TIMELINE_EXPAND_REQUEST = 'TIMELINE_EXPAND_REQUEST' as const;
export const TIMELINE_EXPAND_SUCCESS = 'TIMELINE_EXPAND_SUCCESS' as const;
export const TIMELINE_EXPAND_FAIL    = 'TIMELINE_EXPAND_FAIL' as const;

export const TIMELINE_SCROLL_TOP   = 'TIMELINE_SCROLL_TOP' as const;
export const TIMELINE_LOAD_PENDING = 'TIMELINE_LOAD_PENDING' as const;
export const TIMELINE_CONNECT      = 'TIMELINE_CONNECT' as const;

export const TIMELINE_MARK_AS_PARTIAL = 'TIMELINE_MARK_AS_PARTIAL' as const;
export const TIMELINE_INSERT          = 'TIMELINE_INSERT' as const;

// When adding new special markers here, make sure to update TIMELINE_NON_STATUS_MARKERS in actions/timelines_typed.js
export const TIMELINE_SUGGESTIONS = 'inline-follow-suggestions';
export const TIMELINE_GAP = null;
export const TIMELINE_PINNED_VIEW_ALL = 'pinned-view-all';

export const TIMELINE_NON_STATUS_MARKERS = [
  TIMELINE_GAP,
  TIMELINE_SUGGESTIONS,
  TIMELINE_PINNED_VIEW_ALL,
];

/** A timeline's `items` or `pendingItems`: status ids, `null` gaps and markers. */
const timelineIds = (timeline: Timeline | undefined, key: TimelineListKey) =>
  timeline?.get(key).toArray() ?? [];

const isStatusId = (id: string | null): id is string =>
  id !== null && !isNonStatusId(id);

/** Dispatched by `updateTimeline` (a streamed or posted status). */
export interface TimelineUpdateAction {
  type: typeof TIMELINE_UPDATE;
  timeline: string;
  status: ApiStatusJSON;
  usePendingItems: boolean | undefined;
}

/** Dispatched by `clearTimeline`. */
export interface TimelineClearAction {
  type: typeof TIMELINE_CLEAR;
  timeline: string;
}

export const loadPending = (timeline: string) => ({
  type: TIMELINE_LOAD_PENDING,
  timeline,
});

interface UpdateTimelineOptions {
  accept?: (status: ApiStatusJSON) => boolean;
  bogusQuotePolicy?: boolean;
}

export function updateTimeline(
  timeline: string,
  status: ApiStatusJSON,
  { accept = undefined, bogusQuotePolicy = false }: UpdateTimelineOptions = {},
) {
  return (dispatch: AppDispatch, getState: GetState) => {
    if (typeof accept === 'function' && !accept(status)) {
      return;
    }

    if (getState().timelines.getIn([timeline, 'isPartial'])) {
      // Prevent new items from being added to a partial timeline,
      // since it will be reloaded anyway

      return;
    }

    dispatch(importFetchedStatus(status, { bogusQuotePolicy }));

    dispatch({
      type: TIMELINE_UPDATE,
      timeline,
      status,
      usePendingItems: preferPendingItems,
    } satisfies TimelineUpdateAction);

    if (timeline === 'home') {
      void dispatch(submitMarkers({}));
    }
  };
}

export function deleteFromTimelines(id: string) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const statuses = getState().statuses;
    const status = statuses.get(id);
    const accountId = status?.get('account');
    const references = statuses
      .valueSeq()
      .filter((item) => item.get('reblog') === id)
      .map((item) => item.get('id'))
      .filter((itemId): itemId is string => typeof itemId === 'string')
      .toArray();
    const reblogOf = status?.get('reblog');

    dispatch(
      timelineDelete({
        statusId: id,
        // No reducer reads it; empty when the status is not loaded.
        accountId: typeof accountId === 'string' ? accountId : '',
        references,
        reblogOf: typeof reblogOf === 'string' ? reblogOf : null,
      }),
    );
  };
}

export function clearTimeline(timeline: string) {
  return (dispatch: AppDispatch) => {
    dispatch({ type: TIMELINE_CLEAR, timeline } satisfies TimelineClearAction);
  };
}

/** A hashtag column's extra tags, as its settings store them. */
export interface HashtagTimelineTags {
  any?: { value: string }[];
  all?: { value: string }[];
  none?: { value: string }[];
}

const parseTags = (
  tags: HashtagTimelineTags = {},
  mode: keyof HashtagTimelineTags,
) => {
  return (tags[mode] ?? []).map((tag) => {
    return tag.value;
  });
};

export function expandTimeline(
  timelineId: string,
  path: string,
  params: ApiTimelineParams = {},
) {
  return async (dispatch: AppDispatch, getState: GetState) => {
    const timeline = getState().timelines.get(timelineId);
    const isLoadingMore = !!params.max_id;
    const request = { ...params };

    if (timeline?.get('isLoading')) {
      return;
    }

    const items = timelineIds(timeline, 'items');
    const pendingItems = timelineIds(timeline, 'pendingItems');
    const pinned = 'pinned' in request && request.pinned;

    if (!request.max_id && !pinned && (items.length + pendingItems.length) > 0) {
      const a = pendingItems[0];
      const b = items[0];

      if (a && b && compareId(a, b) > 0) {
        request.since_id = a;
      } else {
        request.since_id = b || a || undefined;
      }
    }

    const isLoadingRecent = !!request.since_id;

    dispatch(expandTimelineRequest(timelineId, isLoadingMore));

    try {
      const { statuses, next, partial } = await apiFetchTimeline(path, request);

      dispatch(importFetchedStatuses(statuses));
      dispatch(expandTimelineSuccess(timelineId, statuses, next ?? null, partial, isLoadingRecent, isLoadingMore, isLoadingRecent && preferPendingItems));

      if (timelineId === 'home' && !isLoadingMore && !isLoadingRecent) {
        const now = Date.now();
        const fittingIndex = statuses.findIndex(status => now - new Date(status.created_at).getTime() > 4 * 3600 * 1000);

        if (fittingIndex !== -1) {
          dispatch(insertIntoTimeline(timelineId, TIMELINE_SUGGESTIONS, Math.max(1, fittingIndex)));
        }
      }

      if (timelineId === 'home') {
        void dispatch(submitMarkers({}));
      }
    } catch(error) {
      dispatch(expandTimelineFail(timelineId, error, isLoadingMore));
    }
  };
}

export function fillTimelineGaps(
  timelineId: string,
  path: string,
  params: ApiTimelineParams = {},
) {
  return async (dispatch: AppDispatch, getState: GetState) => {
    const timeline = getState().timelines.get(timelineId);
    const items = timelineIds(timeline, 'items');

    // A gap (a `null` item) is loaded from the status above it, a gap at the
    // top as the newest statuses.
    const gaps = items.flatMap((statusId, index) =>
      statusId === TIMELINE_GAP ? [items.slice(0, index).findLast(isStatusId)] : [],
    );

    // Only expand at most two gaps to avoid doing too many requests
    for (const maxId of gaps.slice(0, 2)) {
      await dispatch(expandTimeline(timelineId, path, { ...params, max_id: maxId }));
    }
  };
}

interface PublicTimelineOptions {
  maxId?: string;
  onlyMedia?: boolean;
  onlyRemote?: boolean;
}

interface AccountTimelineOptions {
  maxId?: string;
  withReplies?: boolean;
  tagged?: string;
}

interface HashtagTimelineOptions {
  maxId?: string;
  tags?: HashtagTimelineTags;
  local?: boolean;
}

export const expandHomeTimeline            = ({ maxId }: { maxId?: string } = {}) => expandTimeline('home', '/api/v1/timelines/home', { max_id: maxId } satisfies ApiGetHomeTimelineParams);
export const expandPublicTimeline          = ({ maxId, onlyMedia, onlyRemote }: PublicTimelineOptions = {}) => expandTimeline(`public${onlyRemote ? ':remote' : ''}${onlyMedia ? ':media' : ''}`, '/api/v1/timelines/public', { remote: !!onlyRemote, max_id: maxId, only_media: !!onlyMedia } satisfies ApiGetPublicTimelineParams);
export const expandCommunityTimeline       = ({ maxId, onlyMedia }: Omit<PublicTimelineOptions, 'onlyRemote'> = {}) => expandTimeline(`community${onlyMedia ? ':media' : ''}`, '/api/v1/timelines/public', { local: true, max_id: maxId, only_media: !!onlyMedia } satisfies ApiGetPublicTimelineParams);
export const expandAccountTimeline         = (accountId: string, { maxId, withReplies, tagged }: AccountTimelineOptions = {}) => expandTimeline(`account:${accountId}${withReplies ? ':with_replies' : ''}${tagged ? `:${tagged}` : ''}`, `/api/v1/accounts/${accountId}/statuses`, { exclude_replies: !withReplies, exclude_reblogs: withReplies, tagged, max_id: maxId } satisfies ApiGetAccountStatusesParams);
export const expandAccountFeaturedTimeline = (accountId: string, { tagged }: Pick<AccountTimelineOptions, 'tagged'> = {}) => expandTimeline(`account:${accountId}:pinned${tagged ? `:${tagged}` : ''}`, `/api/v1/accounts/${accountId}/statuses`, { pinned: true, tagged } satisfies ApiGetAccountStatusesParams);
export const expandAccountMediaTimeline    = (accountId: string, { maxId, withReplies }: Omit<AccountTimelineOptions, 'tagged'> = {}) => expandTimeline(`account:${accountId}:media${withReplies ? ':with_replies' : ''}`, `/api/v1/accounts/${accountId}/statuses`, { max_id: maxId, only_media: true, limit: 40, exclude_replies: !withReplies } satisfies ApiGetAccountStatusesParams);
export const expandListTimeline            = (id: string, { maxId }: { maxId?: string } = {}) => expandTimeline(`list:${id}`, `/api/v1/timelines/list/${id}`, { max_id: maxId } satisfies ApiGetListTimelineParams);
export const expandLinkTimeline            = (url: string, { maxId }: { maxId?: string } = {}) => expandTimeline(`link:${url}`, `/api/v1/timelines/link`, { url, max_id: maxId } satisfies ApiGetLinkTimelineParams);
export const expandHashtagTimeline         = (hashtag: string, { maxId, tags, local }: HashtagTimelineOptions = {}) => {
  return expandTimeline(`hashtag:${hashtag}${local ? ':local' : ''}`, `/api/v1/timelines/tag/${hashtag}`, {
    max_id: maxId,
    any:    parseTags(tags, 'any'),
    all:    parseTags(tags, 'all'),
    none:   parseTags(tags, 'none'),
    local:  local,
  } satisfies ApiGetTagTimelineParams);
};

export const fillHomeTimelineGaps      = () => fillTimelineGaps('home', '/api/v1/timelines/home', {} satisfies ApiGetHomeTimelineParams);
export const fillPublicTimelineGaps    = ({ onlyMedia, onlyRemote }: Omit<PublicTimelineOptions, 'maxId'> = {}) => fillTimelineGaps(`public${onlyRemote ? ':remote' : ''}${onlyMedia ? ':media' : ''}`, '/api/v1/timelines/public', { remote: !!onlyRemote, only_media: !!onlyMedia } satisfies ApiGetPublicTimelineParams);
export const fillCommunityTimelineGaps = ({ onlyMedia }: Pick<PublicTimelineOptions, 'onlyMedia'> = {}) => fillTimelineGaps(`community${onlyMedia ? ':media' : ''}`, '/api/v1/timelines/public', { local: true, only_media: !!onlyMedia } satisfies ApiGetPublicTimelineParams);
export const fillListTimelineGaps      = (id: string) => fillTimelineGaps(`list:${id}`, `/api/v1/timelines/list/${id}`, {} satisfies ApiGetListTimelineParams);

export function expandTimelineRequest(timeline: string, isLoadingMore: boolean) {
  return {
    type: TIMELINE_EXPAND_REQUEST,
    timeline,
    skipLoading: !isLoadingMore,
  };
}

export function expandTimelineSuccess(
  timeline: string,
  statuses: ApiStatusJSON[],
  next: string | null,
  partial: boolean,
  isLoadingRecent: boolean,
  isLoadingMore: boolean,
  usePendingItems: boolean | undefined,
) {
  return {
    type: TIMELINE_EXPAND_SUCCESS,
    timeline,
    statuses,
    next,
    partial,
    isLoadingRecent,
    usePendingItems,
    skipLoading: !isLoadingMore,
  };
}

export function expandTimelineFail(timeline: string, error: unknown, isLoadingMore: boolean) {
  return {
    type: TIMELINE_EXPAND_FAIL,
    timeline,
    error,
    skipLoading: !isLoadingMore,
    skipNotFound: timeline.startsWith('account:'),
  };
}

export function scrollTopTimeline(timeline: string, top: boolean) {
  return {
    type: TIMELINE_SCROLL_TOP,
    timeline,
    top,
  };
}

export function connectTimeline(timeline: string) {
  return {
    type: TIMELINE_CONNECT,
    timeline,
    usePendingItems: preferPendingItems,
  };
}

export const markAsPartial = (timeline: string) => ({
  type: TIMELINE_MARK_AS_PARTIAL,
  timeline,
});

export const insertIntoTimeline = (timeline: string, key: string, index: number) => ({
  type: TIMELINE_INSERT,
  timeline,
  index,
  key,
});
