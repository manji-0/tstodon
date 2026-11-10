import type { ApiCreateListParams, ApiUpdateListParams } from '@tstodon/api';
import { apiCreate, apiUpdate, apiGetLists } from 'mastodon/api/lists';
import { createDataLoadingThunk } from 'mastodon/store/typed_functions';

export const createList = createDataLoadingThunk(
  'list/create',
  (list: ApiCreateListParams) => apiCreate(list),
);

export const updateList = createDataLoadingThunk(
  'list/update',
  (list: ApiUpdateListParams & { id: string }) => apiUpdate(list),
);

export const fetchLists = createDataLoadingThunk('lists/fetch', () =>
  apiGetLists(),
);
