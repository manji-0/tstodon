import type {
  ApiGetAccountStatusesParams,
  ApiGetHomeTimelineParams,
  ApiGetLinkTimelineParams,
  ApiGetListTimelineParams,
  ApiGetPublicTimelineParams,
  ApiGetTagTimelineParams,
} from '@tstodon/api';
import api, { getLinks } from 'mastodon/api';
import type { ApiStatusJSON } from 'mastodon/api_types/statuses';

/**
 * The params of any of the status timelines `apiFetchTimeline` pages
 * through; each caller builds its own with the endpoint's type.
 */
export type ApiTimelineParams =
  | ApiGetHomeTimelineParams
  | ApiGetPublicTimelineParams
  | ApiGetTagTimelineParams
  | ApiGetListTimelineParams
  | ApiGetLinkTimelineParams
  | ApiGetAccountStatusesParams;

/**
 * A page of a status timeline. `path` is the endpoint as upstream's actions
 * name it: `/api/v1/timelines/home`, `/api/v1/timelines/public`,
 * `/api/v1/timelines/tag/:hashtag`, `/api/v1/timelines/list/:id`,
 * `/api/v1/timelines/link` or `/api/v1/accounts/:id/statuses`. A `206`
 * answer is a partial page (the home feed is still being built).
 */
export const apiFetchTimeline = async (
  path: string,
  params: ApiTimelineParams,
) => {
  const response = await api().get<ApiStatusJSON[]>(path, { params });

  return {
    statuses: response.data,
    next: getLinks(response).refs.find((link) => link.rel === 'next')?.uri,
    partial: response.status === 206,
  };
};
