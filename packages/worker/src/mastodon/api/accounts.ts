import api, {
  apiRequestPost,
  apiRequestGet,
  apiRequestDelete,
  apiRequestPatch,
  getLinks,
} from 'mastodon/api';
import type {
  ApiCreateFeaturedTagParams,
  ApiCredentialAccountJSON,
  ApiFollowAccountParams,
  ApiGetAccountStatusesParams,
  ApiGetAccountsParams,
  ApiGetFamiliarFollowersParams,
  ApiGetRelationshipsParams,
  ApiLookupAccountParams,
  ApiMuteAccountParams,
  ApiSetAccountNoteParams,
  ApiUpdateCredentialsParams,
} from '@tstodon/api';
import type {
  ApiAccountJSON,
  ApiFamiliarFollowersJSON,
} from 'mastodon/api_types/accounts';
import type { ApiRelationshipJSON } from 'mastodon/api_types/relationships';
import type { ApiStatusJSON } from 'mastodon/api_types/statuses';
import type {
  ApiFeaturedTagJSON,
  ApiHashtagJSON,
} from 'mastodon/api_types/tags';

import type {
  ApiProfileJSON,
  ApiProfileUpdateParams,
} from '../api_types/profile';

export const apiGetAccounts = (ids: string[]) =>
  apiRequestGet<ApiAccountJSON[]>('v1/accounts', {
    id: ids,
  } satisfies ApiGetAccountsParams);

export const apiSubmitAccountNote = (id: string, value: string) =>
  apiRequestPost<ApiRelationshipJSON>(`v1/accounts/${id}/note`, {
    comment: value,
  } satisfies ApiSetAccountNoteParams);

export const apiFollowAccount = (id: string, params?: ApiFollowAccountParams) =>
  apiRequestPost<ApiRelationshipJSON>(`v1/accounts/${id}/follow`, {
    ...params,
  });

export const apiUnfollowAccount = (id: string) =>
  apiRequestPost<ApiRelationshipJSON>(`v1/accounts/${id}/unfollow`);

export const apiRemoveAccountFromFollowers = (id: string) =>
  apiRequestPost<ApiRelationshipJSON>(
    `v1/accounts/${id}/remove_from_followers`,
  );

export const apiGetFeaturedTags = (id: string) =>
  apiRequestGet<ApiHashtagJSON[]>(`v1/accounts/${id}/featured_tags`);

export const apiGetCurrentFeaturedTags = () =>
  apiRequestGet<ApiFeaturedTagJSON[]>(`v1/featured_tags`);

export const apiPostFeaturedTag = (name: string) =>
  apiRequestPost<ApiFeaturedTagJSON>('v1/featured_tags', {
    name,
  } satisfies ApiCreateFeaturedTagParams);

export const apiDeleteFeaturedTag = (id: string) =>
  apiRequestDelete(`v1/featured_tags/${id}`);

export const apiGetTagSuggestions = () =>
  apiRequestGet<ApiHashtagJSON[]>('v1/featured_tags/suggestions');

export const apiGetEndorsedAccounts = (id: string) =>
  apiRequestGet<ApiAccountJSON>(`v1/accounts/${id}/endorsements`);

export const apiGetFamiliarFollowers = (id: string) =>
  apiRequestGet<ApiFamiliarFollowersJSON>('v1/accounts/familiar_followers', {
    id: [id],
  } satisfies ApiGetFamiliarFollowersParams);

export const apiGetProfile = () => apiRequestGet<ApiProfileJSON>('v1/profile');

export const apiPatchProfile = (params: ApiProfileUpdateParams | FormData) =>
  apiRequestPatch<ApiProfileJSON>('v1/profile', params);

export const apiDeleteProfileAvatar = () =>
  apiRequestDelete('v1/profile/avatar');

export const apiDeleteProfileHeader = () =>
  apiRequestDelete('v1/profile/header');

export const apiSubscribeByEmail = (id: string, email: string) =>
  apiRequestPost(`v1/accounts/${id}/email_subscriptions`, { email });

export const apiGetAccount = (id: string) =>
  apiRequestGet<ApiAccountJSON>(`v1/accounts/${id}`);

export const apiLookupAccount = (acct: string) =>
  apiRequestGet<ApiAccountJSON>('v1/accounts/lookup', {
    acct,
  } satisfies ApiLookupAccountParams);

export const apiGetRelationships = (ids: string[]) =>
  apiRequestGet<ApiRelationshipJSON[]>('v1/accounts/relationships', {
    id: ids,
    with_suspended: true,
  } satisfies ApiGetRelationshipsParams);

export const apiGetAccountStatuses = (
  id: string,
  params: ApiGetAccountStatusesParams,
) => apiRequestGet<ApiStatusJSON[]>(`v1/accounts/${id}/statuses`, params);

export const apiBlockAccount = (id: string) =>
  apiRequestPost<ApiRelationshipJSON>(`v1/accounts/${id}/block`);

export const apiUnblockAccount = (id: string) =>
  apiRequestPost<ApiRelationshipJSON>(`v1/accounts/${id}/unblock`);

export const apiMuteAccount = (id: string, params: ApiMuteAccountParams) =>
  apiRequestPost<ApiRelationshipJSON>(`v1/accounts/${id}/mute`, params);

export const apiUnmuteAccount = (id: string) =>
  apiRequestPost<ApiRelationshipJSON>(`v1/accounts/${id}/unmute`);

/** Mastodon 4.4's name for upstream's `pin` (which tstodon does not route). */
export const apiEndorseAccount = (id: string) =>
  apiRequestPost<ApiRelationshipJSON>(`v1/accounts/${id}/endorse`);

export const apiUnendorseAccount = (id: string) =>
  apiRequestPost<ApiRelationshipJSON>(`v1/accounts/${id}/unendorse`);

/** A page of accounts; `url` is a `Link` header's next page. */
const apiGetAccountsPage = async (path: string, url?: string) => {
  const response = await api().request<ApiAccountJSON[]>({
    method: 'GET',
    url: url ?? path,
  });

  return {
    accounts: response.data,
    links: getLinks(response),
  };
};

export const apiGetFollowers = (id: string, url?: string) =>
  apiGetAccountsPage(`/api/v1/accounts/${id}/followers`, url);

export const apiGetFollowing = (id: string, url?: string) =>
  apiGetAccountsPage(`/api/v1/accounts/${id}/following`, url);

export const apiGetBlocks = (url?: string) =>
  apiGetAccountsPage('/api/v1/blocks', url);

export const apiGetMutes = (url?: string) =>
  apiGetAccountsPage('/api/v1/mutes', url);

export const apiGetFollowRequests = (url?: string) =>
  apiGetAccountsPage('/api/v1/follow_requests', url);

export const apiAuthorizeFollowRequest = (id: string) =>
  apiRequestPost<ApiRelationshipJSON>(`v1/follow_requests/${id}/authorize`);

export const apiRejectFollowRequest = (id: string) =>
  apiRequestPost<ApiRelationshipJSON>(`v1/follow_requests/${id}/reject`);

export const apiGetStatusRebloggedBy = (statusId: string, url?: string) =>
  apiGetAccountsPage(`/api/v1/statuses/${statusId}/reblogged_by`, url);

export const apiGetStatusFavouritedBy = (statusId: string, url?: string) =>
  apiGetAccountsPage(`/api/v1/statuses/${statusId}/favourited_by`, url);

/** The flat `update_credentials` fields, with the images as files. */
export type ApiUpdateCredentialsFormParams = Omit<
  ApiUpdateCredentialsParams,
  | 'avatar'
  | 'header'
  | 'attribution_domains'
  | 'fields_attributes'
  | 'fields'
  | 'source'
> & { avatar?: Blob; header?: Blob };

/**
 * `PATCH /api/v1/accounts/update_credentials`, sent as a form so the images
 * can go with it (a boolean as `true` / `false`).
 */
export const apiUpdateCredentials = (params: ApiUpdateCredentialsFormParams) => {
  const data = new FormData();

  for (const [key, value] of Object.entries(params)) {
    if (value instanceof Blob) data.append(key, value);
    else if (value !== undefined) data.append(key, String(value));
  }

  return apiRequestPatch<ApiCredentialAccountJSON>(
    'v1/accounts/update_credentials',
    data,
  );
};
