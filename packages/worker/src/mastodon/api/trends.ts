import type {
  ApiGetTrendsParams,
  ApiHashtagJSON,
  ApiStatusJSON,
  ApiTrendsLinkJSON,
} from '@tstodon/api';
import api, { apiRequestGet, getLinks } from 'mastodon/api';

export const apiGetTrendingTags = (params?: ApiGetTrendsParams) =>
  apiRequestGet<ApiHashtagJSON[]>('v1/trends/tags', params);

export const apiGetTrendingLinks = (params?: ApiGetTrendsParams) =>
  apiRequestGet<ApiTrendsLinkJSON[]>('v1/trends/links', params);

/**
 * A page of trending statuses: the first one, or the `next` URL of the
 * page before (the `Link` header's, which carries its own params).
 */
export const apiGetTrendingStatuses = async (
  url?: string,
  params?: ApiGetTrendsParams,
) => {
  const response = await api().get<ApiStatusJSON[]>(
    url ?? '/api/v1/trends/statuses',
    { params },
  );

  return {
    statuses: response.data,
    next: getLinks(response).refs.find((link) => link.rel === 'next')?.uri,
  };
};
