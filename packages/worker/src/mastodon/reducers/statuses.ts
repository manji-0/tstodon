import { createReducer } from '@reduxjs/toolkit';
import { Map as ImmutableMap, List as ImmutableList, fromJS } from 'immutable';

import type { ApiTranslationJSON } from '@tstodon/api';
import { timelineDelete } from 'mastodon/actions/timelines_typed';
import type { Status, StatusJSON } from 'mastodon/models/status';
import { immutableFromJS } from 'mastodon/utils/immutable_map_of';

import { STATUS_IMPORT, STATUSES_IMPORT } from '../actions/importer';
import type { importStatus, importStatuses } from '../actions/importer';
import { normalizeStatusTranslation } from '../actions/importer/normalizer';
import {
  FAVOURITE_REQUEST,
  FAVOURITE_FAIL,
  UNFAVOURITE_REQUEST,
  UNFAVOURITE_FAIL,
  BOOKMARK_REQUEST,
  BOOKMARK_FAIL,
  UNBOOKMARK_REQUEST,
  UNBOOKMARK_FAIL,
} from '../actions/interactions';
import type {
  favouriteRequest,
  favouriteFail,
  unfavouriteRequest,
  unfavouriteFail,
  bookmarkRequest,
  bookmarkFail,
  unbookmarkRequest,
  unbookmarkFail,
} from '../actions/interactions';
import { reblog, unreblog } from '../actions/interactions_typed';
import {
  STATUS_MUTE_SUCCESS,
  STATUS_UNMUTE_SUCCESS,
  STATUS_REVEAL,
  STATUS_HIDE,
  STATUS_COLLAPSE,
  STATUS_TRANSLATE_SUCCESS,
  STATUS_TRANSLATE_UNDO,
  STATUS_FETCH_REQUEST,
  STATUS_FETCH_FAIL,
} from '../actions/statuses';
import type {
  muteStatusSuccess,
  unmuteStatusSuccess,
  revealStatus,
  hideStatus,
  toggleStatusCollapse,
  translateStatusSuccess,
  undoStatusTranslation,
  fetchStatusRequest,
  fetchStatusFail,
} from '../actions/statuses';
import { setStatusQuotePolicy } from '../actions/statuses_typed';

import { matchAction } from './match_action';

/**
 * The statuses by id: each the importer's `NormalizedStatus` through
 * `fromJS`, plus the flags set here (`isLoading` on a stub being fetched,
 * `hidden`, `collapsed`, `translation`, `isSavingQuotePolicy`, ...), typed
 * per field (`Status`, an `ImmutableMapOf<StatusFields>`).
 */
export type StatusesState = ImmutableMap<string, Status>;

const storeStatus = (state: StatusesState, status: StatusJSON) =>
  state.set(status.id, immutableFromJS(status));

const storeStatuses = (state: StatusesState, statuses: StatusJSON[]) =>
  state.withMutations((mutable) => {
    statuses.forEach((status) => storeStatus(mutable, status));
  });

const deleteStatus = (
  state: StatusesState,
  id: string,
  references: string[],
): StatusesState => {
  references.forEach((ref) => {
    state = deleteStatus(state, ref, []);
  });

  return state.delete(id);
};

const statusTranslateSuccess = (
  state: StatusesState,
  id: string,
  translation: ApiTranslationJSON,
) => {
  const status = state.get(id);

  // The status was deleted while it was being translated.
  if (!status) {
    return state;
  }

  return state.withMutations((map) => {
    map.setIn(
      [id, 'translation'],
      fromJS(normalizeStatusTranslation(translation, status)),
    );

    const list = map.getIn([id, 'media_attachments']);
    if (translation.media_attachments && ImmutableList.isList(list)) {
      translation.media_attachments.forEach((item) => {
        const index = list.findIndex(
          (i) => ImmutableMap.isMap(i) && i.get('id') === item.id,
        );

        // At -1, `setIn` would write the last attachment's translation.
        if (index !== -1) {
          map.setIn(
            [id, 'media_attachments', index, 'translation'],
            fromJS({ description: item.description }),
          );
        }
      });
    }
  });
};

const statusTranslateUndo = (state: StatusesState, id: string) => {
  return state.withMutations((map) => {
    map.deleteIn([id, 'translation']);

    const list = map.getIn([id, 'media_attachments']);
    if (ImmutableList.isList(list)) {
      list.forEach((_item, index) =>
        map.deleteIn([id, 'media_attachments', index, 'translation']),
      );
    }
  });
};

const removeStatusStub = (state: StatusesState, id: string) => {
  return state.getIn([id, 'id'])
    ? state.deleteIn([id, 'isLoading'])
    : state.delete(id);
};

const setFlag = (
  state: StatusesState,
  id: string,
  key: string,
  value: boolean,
) => state.setIn([id, key], value);

/** Sets the flag only on a status in the store. */
const setFlagIfPresent = (
  state: StatusesState,
  id: string,
  key: string,
  value: boolean,
) => (state.get(id) === undefined ? state : setFlag(state, id, key, value));

const setHidden = (state: StatusesState, ids: string[], hidden: boolean) =>
  state.withMutations((map) => {
    ids.forEach((id) => {
      if (!(state.get(id) === undefined)) {
        map.setIn([id, 'hidden'], hidden);
      }
    });
  });

const isNotFound = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'status' in error &&
  error.status === 404;

const isFetchRequest =
  matchAction<ReturnType<typeof fetchStatusRequest>>(STATUS_FETCH_REQUEST);
const isFetchFail =
  matchAction<ReturnType<typeof fetchStatusFail>>(STATUS_FETCH_FAIL);
const isImport = matchAction<ReturnType<typeof importStatus>>(STATUS_IMPORT);
const isImports =
  matchAction<ReturnType<typeof importStatuses>>(STATUSES_IMPORT);
const isFavouriteRequest =
  matchAction<ReturnType<typeof favouriteRequest>>(FAVOURITE_REQUEST);
const isFavouriteFail =
  matchAction<ReturnType<typeof favouriteFail>>(FAVOURITE_FAIL);
const isUnfavouriteRequest =
  matchAction<ReturnType<typeof unfavouriteRequest>>(UNFAVOURITE_REQUEST);
const isUnfavouriteFail =
  matchAction<ReturnType<typeof unfavouriteFail>>(UNFAVOURITE_FAIL);
const isBookmarkRequest =
  matchAction<ReturnType<typeof bookmarkRequest>>(BOOKMARK_REQUEST);
const isBookmarkFail =
  matchAction<ReturnType<typeof bookmarkFail>>(BOOKMARK_FAIL);
const isUnbookmarkRequest =
  matchAction<ReturnType<typeof unbookmarkRequest>>(UNBOOKMARK_REQUEST);
const isUnbookmarkFail =
  matchAction<ReturnType<typeof unbookmarkFail>>(UNBOOKMARK_FAIL);
const isMuteSuccess =
  matchAction<ReturnType<typeof muteStatusSuccess>>(STATUS_MUTE_SUCCESS);
const isUnmuteSuccess = matchAction<ReturnType<typeof unmuteStatusSuccess>>(
  STATUS_UNMUTE_SUCCESS,
);
const isReveal = matchAction<ReturnType<typeof revealStatus>>(STATUS_REVEAL);
const isHide = matchAction<ReturnType<typeof hideStatus>>(STATUS_HIDE);
const isCollapse =
  matchAction<ReturnType<typeof toggleStatusCollapse>>(STATUS_COLLAPSE);
const isTranslateSuccess = matchAction<
  ReturnType<typeof translateStatusSuccess>
>(STATUS_TRANSLATE_SUCCESS);
const isTranslateUndo = matchAction<ReturnType<typeof undoStatusTranslation>>(
  STATUS_TRANSLATE_UNDO,
);

const initialState: StatusesState = ImmutableMap();

const statusesReducer = createReducer(initialState, (builder) => {
  builder
    .addCase(setStatusQuotePolicy.pending, (state, action) => {
      const { statusId } = action.meta.arg;
      return state.get(statusId)
        ? setFlag(state, statusId, 'isSavingQuotePolicy', true)
        : state;
    })
    .addCase(setStatusQuotePolicy.fulfilled, (state, action) => {
      const { id, quote_approval } = action.payload;
      return state.get(id)
        ? state
            .setIn([id, 'quote_approval'], immutableFromJS(quote_approval))
            .deleteIn([id, 'isSavingQuotePolicy'])
        : state;
    })
    .addCase(setStatusQuotePolicy.rejected, (state, action) =>
      state.deleteIn([action.meta.arg.statusId, 'isSavingQuotePolicy']),
    )
    .addCase(timelineDelete, (state, action) =>
      deleteStatus(state, action.payload.statusId, action.payload.references),
    )
    .addCase(reblog.pending, (state, action) =>
      setFlag(state, action.meta.arg.statusId, 'reblogged', true),
    )
    .addCase(reblog.rejected, (state, action) =>
      setFlagIfPresent(state, action.meta.arg.statusId, 'reblogged', false),
    )
    .addCase(unreblog.pending, (state, action) =>
      setFlag(state, action.meta.arg.statusId, 'reblogged', false),
    )
    .addCase(unreblog.rejected, (state, action) =>
      setFlagIfPresent(state, action.meta.arg.statusId, 'reblogged', true),
    )
    .addMatcher(isFetchRequest, (state, action) =>
      setFlag(state, action.id, 'isLoading', true),
    )
    .addMatcher(isFetchFail, (state, action) => {
      if (action.parentQuotePostId && isNotFound(action.error)) {
        return removeStatusStub(state, action.id).setIn(
          [action.parentQuotePostId, 'quote', 'state'],
          'deleted',
        );
      } else {
        return removeStatusStub(state, action.id);
      }
    })
    .addMatcher(isImport, (state, action) => storeStatus(state, action.status))
    .addMatcher(isImports, (state, action) =>
      storeStatuses(state, action.statuses),
    )
    .addMatcher(isFavouriteRequest, (state, action) =>
      setFlag(state, action.status.get('id'), 'favourited', true),
    )
    .addMatcher(isFavouriteFail, (state, action) =>
      setFlagIfPresent(
        state,
        action.status.get('id'),
        'favourited',
        false,
      ),
    )
    .addMatcher(isUnfavouriteRequest, (state, action) =>
      setFlag(state, action.status.get('id'), 'favourited', false),
    )
    .addMatcher(isUnfavouriteFail, (state, action) =>
      setFlagIfPresent(
        state,
        action.status.get('id'),
        'favourited',
        true,
      ),
    )
    .addMatcher(isBookmarkRequest, (state, action) =>
      setFlagIfPresent(
        state,
        action.status.get('id'),
        'bookmarked',
        true,
      ),
    )
    .addMatcher(isBookmarkFail, (state, action) =>
      setFlagIfPresent(
        state,
        action.status.get('id'),
        'bookmarked',
        false,
      ),
    )
    .addMatcher(isUnbookmarkRequest, (state, action) =>
      setFlagIfPresent(
        state,
        action.status.get('id'),
        'bookmarked',
        false,
      ),
    )
    .addMatcher(isUnbookmarkFail, (state, action) =>
      setFlagIfPresent(
        state,
        action.status.get('id'),
        'bookmarked',
        true,
      ),
    )
    .addMatcher(isMuteSuccess, (state, action) =>
      setFlag(state, action.id, 'muted', true),
    )
    .addMatcher(isUnmuteSuccess, (state, action) =>
      setFlag(state, action.id, 'muted', false),
    )
    .addMatcher(isReveal, (state, action) =>
      setHidden(state, action.ids, false),
    )
    .addMatcher(isHide, (state, action) => setHidden(state, action.ids, true))
    .addMatcher(isCollapse, (state, action) =>
      state.setIn([action.id, 'collapsed'], action.isCollapsed),
    )
    .addMatcher(isTranslateSuccess, (state, action) =>
      statusTranslateSuccess(state, action.id, action.translation),
    )
    .addMatcher(isTranslateUndo, (state, action) =>
      statusTranslateUndo(state, action.id),
    );
});

export default statusesReducer;
