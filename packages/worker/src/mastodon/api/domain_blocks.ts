import type { ApiDomainBlockParams } from '@tstodon/api';
import api, {
  apiRequestDelete,
  apiRequestPost,
  getLinks,
} from 'mastodon/api';

export const apiGetDomainBlocks = async (url?: string) => {
  const response = await api().request<string[]>({
    method: 'GET',
    url: url ?? '/api/v1/domain_blocks',
  });

  return {
    domains: response.data,
    links: getLinks(response),
  };
};

export const apiBlockDomain = (domain: string) =>
  apiRequestPost<Record<string, never>>('v1/domain_blocks', {
    domain,
  } satisfies ApiDomainBlockParams);

/** The domain goes in the query, as upstream sends it. */
export const apiUnblockDomain = (domain: string) =>
  apiRequestDelete<Record<string, never>>('v1/domain_blocks', {
    domain,
  } satisfies ApiDomainBlockParams);
