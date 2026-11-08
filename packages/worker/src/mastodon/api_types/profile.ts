import type { ApiAccountFieldJSON, ApiProfileJSON } from '@tstodon/api';

// The entity lives in @tstodon/api (packages/api), shared with the server.
export type { ApiProfileJSON } from '@tstodon/api';

export type ApiProfileUpdateParams = Partial<
  Pick<
    ApiProfileJSON,
    | 'avatar_description'
    | 'header_description'
    | 'display_name'
    | 'note'
    | 'locked'
    | 'bot'
    | 'hide_collections'
    | 'discoverable'
    | 'indexable'
    | 'show_media'
    | 'show_media_replies'
    | 'show_featured'
  >
> & {
  attribution_domains?: string[];
  fields_attributes?: Pick<ApiAccountFieldJSON, 'name' | 'value'>[];
};
