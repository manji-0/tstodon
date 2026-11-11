import { defineMessages } from 'react-intl';

import { isAxiosError } from 'axios';

import type { ApiTranslationJSON } from '@tstodon/api';
import {
  apiDeleteStatus,
  apiGetStatus,
  apiGetStatusSource,
  apiMuteStatus,
  apiTranslateStatus,
  apiUnmuteStatus,
} from 'mastodon/api/statuses';
import { browserHistory } from 'mastodon/components/router';
import type { AnyStatus } from 'mastodon/models/status';
import { immutableMapWith } from 'mastodon/utils/immutable_map_of';
import type { AppDispatch, GetState } from 'mastodon/store';

import { showAlert } from './alerts';
import { ensureComposeIsVisible, setComposeToStatus } from './compose';
import { importFetchedStatus, importFetchedAccount } from './importer';
import type { ImportFetchedStatusesOptions } from './importer';
import type { FetchedStatusJSON } from './importer/normalizer';
import { fetchContext } from './statuses_typed';
import { deleteFromTimelines } from './timelines';

export * from './statuses_typed';

export const STATUS_FETCH_REQUEST = 'STATUS_FETCH_REQUEST' as const;
export const STATUS_FETCH_SUCCESS = 'STATUS_FETCH_SUCCESS';
export const STATUS_FETCH_FAIL = 'STATUS_FETCH_FAIL' as const;

export const STATUS_DELETE_REQUEST = 'STATUS_DELETE_REQUEST';
export const STATUS_DELETE_SUCCESS = 'STATUS_DELETE_SUCCESS';
export const STATUS_DELETE_FAIL = 'STATUS_DELETE_FAIL';

export const STATUS_MUTE_REQUEST = 'STATUS_MUTE_REQUEST';
export const STATUS_MUTE_SUCCESS = 'STATUS_MUTE_SUCCESS' as const;
export const STATUS_MUTE_FAIL = 'STATUS_MUTE_FAIL';

export const STATUS_UNMUTE_REQUEST = 'STATUS_UNMUTE_REQUEST';
export const STATUS_UNMUTE_SUCCESS = 'STATUS_UNMUTE_SUCCESS' as const;
export const STATUS_UNMUTE_FAIL = 'STATUS_UNMUTE_FAIL';

export const STATUS_REVEAL = 'STATUS_REVEAL' as const;
export const STATUS_HIDE = 'STATUS_HIDE' as const;
export const STATUS_COLLAPSE = 'STATUS_COLLAPSE' as const;

export const REDRAFT = 'REDRAFT';

export const STATUS_FETCH_SOURCE_REQUEST = 'STATUS_FETCH_SOURCE_REQUEST';
export const STATUS_FETCH_SOURCE_SUCCESS = 'STATUS_FETCH_SOURCE_SUCCESS';
export const STATUS_FETCH_SOURCE_FAIL = 'STATUS_FETCH_SOURCE_FAIL';

export const STATUS_TRANSLATE_REQUEST = 'STATUS_TRANSLATE_REQUEST';
export const STATUS_TRANSLATE_SUCCESS = 'STATUS_TRANSLATE_SUCCESS' as const;
export const STATUS_TRANSLATE_FAIL = 'STATUS_TRANSLATE_FAIL';
export const STATUS_TRANSLATE_UNDO = 'STATUS_TRANSLATE_UNDO' as const;

const messages = defineMessages({
  deleteSuccess: {
    id: 'status.delete.success',
    defaultMessage: 'Post deleted',
  },
});

/** The status, with its poll (an id in the store) replaced by the poll. */
const statusWithPoll = (
  getState: GetState,
  id: string,
): AnyStatus | undefined => {
  const status = getState().statuses.get(id);
  const pollId = status?.get('poll');

  if (status && pollId) {
    return immutableMapWith(status, 'poll', getState().polls[pollId]);
  }

  return status;
};

export function fetchStatusRequest(id: string, skipLoading: boolean) {
  return {
    type: STATUS_FETCH_REQUEST,
    id,
    skipLoading,
  };
}

export function fetchStatus(
  id: string,
  {
    forceFetch = false,
    alsoFetchContext = true,
    parentQuotePostId,
  }: {
    forceFetch?: boolean;
    alsoFetchContext?: boolean;
    parentQuotePostId?: string | null;
  } = {},
) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const skipLoading = !forceFetch && getState().statuses.has(id);

    if (alsoFetchContext) {
      void dispatch(fetchContext({ statusId: id }));
    }

    if (skipLoading) {
      return;
    }

    dispatch(fetchStatusRequest(id, skipLoading));

    apiGetStatus(id)
      .then((status) => {
        dispatch(importFetchedStatus(status));
        dispatch(fetchStatusSuccess(skipLoading));
      })
      .catch((error: unknown) => {
        dispatch(fetchStatusFail(id, error, skipLoading, parentQuotePostId));
        if (isAxiosError(error) && error.status === 404)
          dispatch(deleteFromTimelines(id));
      });
  };
}

export function fetchStatusSuccess(skipLoading: boolean) {
  return {
    type: STATUS_FETCH_SUCCESS,
    skipLoading,
  };
}

export function fetchStatusFail(
  id: string,
  error: unknown,
  skipLoading: boolean,
  parentQuotePostId?: string | null,
) {
  return {
    type: STATUS_FETCH_FAIL,
    id,
    error,
    parentQuotePostId,
    skipLoading,
    skipAlert: true,
  };
}

export type RedraftAction = {
  type: typeof REDRAFT;
  status: AnyStatus;
  raw_text: string | null | undefined;
  quoted_status_id: string | null;
  /** The server's `configuration.polls.max_options`, when known. */
  maxOptions: number | undefined;
};

export function redraft(
  status: AnyStatus,
  raw_text: string | null | undefined,
  quoted_status_id: string | null = null,
) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const maxOptions =
      getState().server.server.item?.configuration.polls.max_options;

    dispatch({
      type: REDRAFT,
      status,
      raw_text,
      quoted_status_id,
      maxOptions,
    } satisfies RedraftAction);
  };
}

export const editStatus =
  (id: string) => (dispatch: AppDispatch, getState: GetState) => {
    const status = statusWithPoll(getState, id);

    if (!status) {
      return;
    }

    dispatch(fetchStatusSourceRequest());

    apiGetStatusSource(id)
      .then((source) => {
        dispatch(fetchStatusSourceSuccess());
        ensureComposeIsVisible(getState);
        dispatch(setComposeToStatus(status, source.text, source.spoiler_text));
      })
      .catch((error: unknown) => {
        dispatch(fetchStatusSourceFail(error));
      });
  };

export const fetchStatusSourceRequest = () => ({
  type: STATUS_FETCH_SOURCE_REQUEST,
});

export const fetchStatusSourceSuccess = () => ({
  type: STATUS_FETCH_SOURCE_SUCCESS,
});

export const fetchStatusSourceFail = (error: unknown) => ({
  type: STATUS_FETCH_SOURCE_FAIL,
  error,
});

export function deleteStatus(id: string, withRedraft = false) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const status = statusWithPoll(getState, id);

    dispatch(deleteStatusRequest(id));

    return apiDeleteStatus(id, { delete_media: !withRedraft })
      .then((deleted) => {
        dispatch(deleteStatusSuccess(id));
        dispatch(deleteFromTimelines(id));
        dispatch(importFetchedAccount(deleted.account));

        if (withRedraft) {
          if (status) {
            dispatch(
              redraft(status, deleted.text, deleted.quote?.quoted_status?.id),
            );
          }
          ensureComposeIsVisible(getState);
        } else {
          dispatch(showAlert({ message: messages.deleteSuccess }));
        }

        return deleted;
      })
      .catch((error: unknown) => {
        dispatch(deleteStatusFail(id, error));
        throw error;
      });
  };
}

export function deleteStatusRequest(id: string) {
  return {
    type: STATUS_DELETE_REQUEST,
    id: id,
  };
}

export function deleteStatusSuccess(id: string) {
  return {
    type: STATUS_DELETE_SUCCESS,
    id: id,
  };
}

export function deleteStatusFail(id: string, error: unknown) {
  return {
    type: STATUS_DELETE_FAIL,
    id: id,
    error: error,
  };
}

export const updateStatus =
  (
    status: FetchedStatusJSON,
    { bogusQuotePolicy }: ImportFetchedStatusesOptions,
  ) =>
  (dispatch: AppDispatch) =>
    dispatch(importFetchedStatus(status, { bogusQuotePolicy }));

export function muteStatus(id: string) {
  return (dispatch: AppDispatch) => {
    dispatch(muteStatusRequest(id));

    apiMuteStatus(id)
      .then(() => {
        dispatch(muteStatusSuccess(id));
      })
      .catch((error: unknown) => {
        dispatch(muteStatusFail(id, error));
      });
  };
}

export function muteStatusRequest(id: string) {
  return {
    type: STATUS_MUTE_REQUEST,
    id,
  };
}

export function muteStatusSuccess(id: string) {
  return {
    type: STATUS_MUTE_SUCCESS,
    id,
  };
}

export function muteStatusFail(id: string, error: unknown) {
  return {
    type: STATUS_MUTE_FAIL,
    id,
    error,
  };
}

export function unmuteStatus(id: string) {
  return (dispatch: AppDispatch) => {
    dispatch(unmuteStatusRequest(id));

    apiUnmuteStatus(id)
      .then(() => {
        dispatch(unmuteStatusSuccess(id));
      })
      .catch((error: unknown) => {
        dispatch(unmuteStatusFail(id, error));
      });
  };
}

export function unmuteStatusRequest(id: string) {
  return {
    type: STATUS_UNMUTE_REQUEST,
    id,
  };
}

export function unmuteStatusSuccess(id: string) {
  return {
    type: STATUS_UNMUTE_SUCCESS,
    id,
  };
}

export function unmuteStatusFail(id: string, error: unknown) {
  return {
    type: STATUS_UNMUTE_FAIL,
    id,
    error,
  };
}

export function hideStatus(ids: string | string[]) {
  return {
    type: STATUS_HIDE,
    ids: Array.isArray(ids) ? ids : [ids],
  };
}

export function revealStatus(ids: string | string[]) {
  return {
    type: STATUS_REVEAL,
    ids: Array.isArray(ids) ? ids : [ids],
  };
}

export function toggleStatusSpoilers(statusId: string) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const status = getState().statuses.get(statusId);

    if (!status) return;

    if (status.get('hidden')) {
      dispatch(revealStatus(statusId));
    } else {
      dispatch(hideStatus(statusId));
    }
  };
}

export function toggleStatusCollapse(id: string, isCollapsed: boolean) {
  return {
    type: STATUS_COLLAPSE,
    id,
    isCollapsed,
  };
}

export const translateStatus = (id: string) => (dispatch: AppDispatch) => {
  dispatch(translateStatusRequest(id));

  apiTranslateStatus(id)
    .then((translation) => {
      dispatch(translateStatusSuccess(id, translation));
    })
    .catch((error: unknown) => {
      dispatch(translateStatusFail(id, error));
    });
};

export const translateStatusRequest = (id: string) => ({
  type: STATUS_TRANSLATE_REQUEST,
  id,
});

export const translateStatusSuccess = (
  id: string,
  translation: ApiTranslationJSON,
) => ({
  type: STATUS_TRANSLATE_SUCCESS,
  id,
  translation,
});

export const translateStatusFail = (id: string, error: unknown) => ({
  type: STATUS_TRANSLATE_FAIL,
  id,
  error,
});

export const undoStatusTranslation = (
  id: string,
  pollId: string | undefined,
) => ({
  type: STATUS_TRANSLATE_UNDO,
  id,
  pollId,
});

export const navigateToStatus = (statusId: string) => {
  return (_dispatch: AppDispatch, getState: GetState) => {
    const state = getState();
    const accountId = state.statuses.get(statusId)?.get('account');
    const acct =
      typeof accountId === 'string'
        ? state.accounts.get(accountId)?.get('acct')
        : undefined;

    if (acct) {
      browserHistory.push(`/@${acct}/${statusId}`);
    }
  };
};
