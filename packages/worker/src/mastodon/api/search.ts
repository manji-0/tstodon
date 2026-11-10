import type { ApiSearchAccountsParams, ApiSearchParams } from '@tstodon/api';
import { apiRequestGet } from 'mastodon/api';
import type { ApiAccountJSON } from 'mastodon/api_types/accounts';
import type {
  ApiSearchType,
  ApiSearchResultsJSON,
} from 'mastodon/api_types/search';

export const apiGetSearch = (
  params: ApiSearchParams & {
    q: string;
    type?: ApiSearchType;
  },
  options: {
    signal?: AbortSignal;
  } = {},
) =>
  apiRequestGet<ApiSearchResultsJSON>(
    'v2/search',
    {
      ...params,
    },
    options,
  );

export const apiSearchAccounts = (
  params: ApiSearchAccountsParams & { q: string },
  options: {
    signal?: AbortSignal;
  } = {},
) => apiRequestGet<ApiAccountJSON[]>('v1/accounts/search', params, options);
