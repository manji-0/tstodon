import type { ApiSearchParams } from '@tstodon/api';
import { apiRequestGet } from 'mastodon/api';
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
