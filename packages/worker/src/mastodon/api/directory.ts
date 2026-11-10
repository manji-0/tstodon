import type { ApiGetDirectoryParams } from '@tstodon/api';
import { apiRequestGet } from 'mastodon/api';
import type { ApiAccountJSON } from 'mastodon/api_types/accounts';

export const apiGetDirectory = (
  params: Omit<ApiGetDirectoryParams, 'limit'>,
  limit = 20,
) =>
  apiRequestGet<ApiAccountJSON[]>('v1/directory', {
    ...params,
    limit,
  } satisfies ApiGetDirectoryParams);
