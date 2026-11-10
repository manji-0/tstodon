import type { ApiReblogParams } from '@tstodon/api';
import api, { apiRequestPost, getLinks } from 'mastodon/api';
import type { ApiStatusJSON } from 'mastodon/api_types/statuses';
import type { StatusVisibility } from 'mastodon/models/status';

export const apiReblog = (statusId: string, visibility?: StatusVisibility) =>
  apiRequestPost<{ reblog: ApiStatusJSON }>(`v1/statuses/${statusId}/reblog`, {
    visibility,
  } satisfies ApiReblogParams);

export const apiUnreblog = (statusId: string) =>
  apiRequestPost<ApiStatusJSON>(`v1/statuses/${statusId}/unreblog`);

export const apiRevokeQuote = (quotedStatusId: string, statusId: string) =>
  apiRequestPost<ApiStatusJSON>(
    `v1/statuses/${quotedStatusId}/quotes/${statusId}/revoke`,
  );

export const apiGetQuotes = async (statusId: string, url?: string) => {
  const response = await api().request<ApiStatusJSON[]>({
    method: 'GET',
    url: url ?? `/api/v1/statuses/${statusId}/quotes`,
  });

  return {
    statuses: response.data,
    links: getLinks(response),
  };
};

export const apiFavourite = (statusId: string) =>
  apiRequestPost<ApiStatusJSON>(`v1/statuses/${statusId}/favourite`);

export const apiUnfavourite = (statusId: string) =>
  apiRequestPost<ApiStatusJSON>(`v1/statuses/${statusId}/unfavourite`);

export const apiBookmark = (statusId: string) =>
  apiRequestPost<ApiStatusJSON>(`v1/statuses/${statusId}/bookmark`);

export const apiUnbookmark = (statusId: string) =>
  apiRequestPost<ApiStatusJSON>(`v1/statuses/${statusId}/unbookmark`);

export const apiPin = (statusId: string) =>
  apiRequestPost<ApiStatusJSON>(`v1/statuses/${statusId}/pin`);

export const apiUnpin = (statusId: string) =>
  apiRequestPost<ApiStatusJSON>(`v1/statuses/${statusId}/unpin`);

/** A page of statuses; `url` is a `Link` header's next page. */
const apiGetStatusesPage = async (path: string, url?: string) => {
  const response = await api().request<ApiStatusJSON[]>({
    method: 'GET',
    url: url ?? path,
  });

  return {
    statuses: response.data,
    links: getLinks(response),
  };
};

export const apiGetFavourites = (url?: string) =>
  apiGetStatusesPage('/api/v1/favourites', url);

export const apiGetBookmarks = (url?: string) =>
  apiGetStatusesPage('/api/v1/bookmarks', url);
