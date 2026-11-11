import { apiDeleteList, apiGetList } from 'mastodon/api/lists';
import type { ApiListJSON } from 'mastodon/api_types/lists';
import type { AppDispatch, GetState } from 'mastodon/store';

export const LIST_FETCH_REQUEST = 'LIST_FETCH_REQUEST';
export const LIST_FETCH_SUCCESS = 'LIST_FETCH_SUCCESS';
export const LIST_FETCH_FAIL    = 'LIST_FETCH_FAIL' as const;

export const LIST_DELETE_REQUEST = 'LIST_DELETE_REQUEST';
export const LIST_DELETE_SUCCESS = 'LIST_DELETE_SUCCESS' as const;
export const LIST_DELETE_FAIL    = 'LIST_DELETE_FAIL';

export * from './lists_typed';

export const fetchList = (id: string) => (dispatch: AppDispatch, getState: GetState) => {
  if (getState().lists.get(id)) {
    return;
  }

  dispatch(fetchListRequest(id));

  apiGetList(id)
    .then((data) => dispatch(fetchListSuccess(data)))
    .catch((err: unknown) => dispatch(fetchListFail(id, err)));
};

export const fetchListRequest = (id: string) => ({
  type: LIST_FETCH_REQUEST,
  id,
});

export const fetchListSuccess = (list: ApiListJSON) => ({
  type: LIST_FETCH_SUCCESS,
  list,
});

export const fetchListFail = (id: string, error: unknown) => ({
  type: LIST_FETCH_FAIL,
  id,
  error,
});

export const deleteList = (id: string) => (dispatch: AppDispatch) => {
  dispatch(deleteListRequest(id));

  apiDeleteList(id)
    .then(() => dispatch(deleteListSuccess(id)))
    .catch((err: unknown) => dispatch(deleteListFail(id, err)));
};

export const deleteListRequest = (id: string) => ({
  type: LIST_DELETE_REQUEST,
  id,
});

export const deleteListSuccess = (id: string) => ({
  type: LIST_DELETE_SUCCESS,
  id,
});

export const deleteListFail = (id: string, error: unknown) => ({
  type: LIST_DELETE_FAIL,
  id,
  error,
});
