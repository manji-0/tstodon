import type {
  ApiCreateFilterStatusParams,
  ApiFilterJSON,
  ApiFilterParams,
  ApiFilterStatusJSON,
} from '@tstodon/api';
import {
  apiCreateFilter,
  apiCreateFilterStatus,
  apiGetFilters,
} from 'mastodon/api/filters';
import type { Status } from 'mastodon/models/status';
import type { AppDispatch } from 'mastodon/store';

import { openModal } from './modal';

export const FILTERS_FETCH_REQUEST = 'FILTERS_FETCH_REQUEST';
export const FILTERS_FETCH_SUCCESS = 'FILTERS_FETCH_SUCCESS';
export const FILTERS_FETCH_FAIL    = 'FILTERS_FETCH_FAIL';

export const FILTERS_STATUS_CREATE_REQUEST = 'FILTERS_STATUS_CREATE_REQUEST';
export const FILTERS_STATUS_CREATE_SUCCESS = 'FILTERS_STATUS_CREATE_SUCCESS';
export const FILTERS_STATUS_CREATE_FAIL    = 'FILTERS_STATUS_CREATE_FAIL';

export const FILTERS_CREATE_REQUEST = 'FILTERS_CREATE_REQUEST';
export const FILTERS_CREATE_SUCCESS = 'FILTERS_CREATE_SUCCESS';
export const FILTERS_CREATE_FAIL    = 'FILTERS_CREATE_FAIL';

export const initAddFilter = (status: Status | null | undefined, { contextType }: { contextType?: string }) => (dispatch: AppDispatch) =>
  dispatch(openModal({
    modalType: 'FILTER',
    modalProps: {
      statusId: status?.get('id'),
      contextType: contextType,
    },
  }));

export const fetchFilters = () => (dispatch: AppDispatch) => {
  dispatch({
    type: FILTERS_FETCH_REQUEST,
    skipLoading: true,
  });

  apiGetFilters()
    .then((data) => dispatch({
      type: FILTERS_FETCH_SUCCESS,
      filters: data,
      skipLoading: true,
    }))
    .catch((err: unknown) => dispatch({
      type: FILTERS_FETCH_FAIL,
      err,
      skipLoading: true,
      skipAlert: true,
    }));
};

/** The filter to narrow (`filter_id`, in the path) and the status to narrow it to. */
type CreateFilterStatusParams = ApiCreateFilterStatusParams & { filter_id: string };

export const createFilterStatus = (
  { filter_id, ...params }: CreateFilterStatusParams,
  onSuccess?: () => void,
  onFail?: () => void,
) => (dispatch: AppDispatch) => {
  dispatch(createFilterStatusRequest());

  apiCreateFilterStatus(filter_id, params).then(filterStatus => {
    dispatch(createFilterStatusSuccess(filterStatus));
    if (onSuccess) onSuccess();
  }).catch((error: unknown) => {
    dispatch(createFilterStatusFail(error));
    if (onFail) onFail();
  });
};

export const createFilterStatusRequest = () => ({
  type: FILTERS_STATUS_CREATE_REQUEST,
});

export const createFilterStatusSuccess = (filter_status: ApiFilterStatusJSON) => ({
  type: FILTERS_STATUS_CREATE_SUCCESS,
  filter_status,
});

export const createFilterStatusFail = (error: unknown) => ({
  type: FILTERS_STATUS_CREATE_FAIL,
  error,
});

export const createFilter = (
  params: ApiFilterParams,
  onSuccess?: (filter: ApiFilterJSON) => void,
  onFail?: () => void,
) => (dispatch: AppDispatch) => {
  dispatch(createFilterRequest());

  apiCreateFilter(params).then(filter => {
    dispatch(createFilterSuccess(filter));
    if (onSuccess) onSuccess(filter);
  }).catch((error: unknown) => {
    dispatch(createFilterFail(error));
    if (onFail) onFail();
  });
};

export const createFilterRequest = () => ({
  type: FILTERS_CREATE_REQUEST,
});

export const createFilterSuccess = (filter: ApiFilterJSON) => ({
  type: FILTERS_CREATE_SUCCESS,
  filter,
});

export const createFilterFail = (error: unknown) => ({
  type: FILTERS_CREATE_FAIL,
  error,
});
