// See app/serializers/rest/base_collection_serializer.rb

import type {
  ApiAccountJSON,
  ApiCollectionJSON,
  CollectionAccountItem,
} from '@tstodon/api';

// The collection and its item live in @tstodon/api (packages/api), shared
// with the server.
export type { ApiCollectionJSON, CollectionAccountItem } from '@tstodon/api';

/**
 * Returned when fetching all collections for an account
 */
export interface ApiCollectionsJSON {
  collections: ApiCollectionJSON[];
}

/**
 * Returned when creating, updating, and adding to a collection
 */
export interface ApiWrappedCollectionJSON {
  collection: ApiCollectionJSON;
}

/**
 * Returned when fetching a single collection
 */
export interface ApiCollectionWithAccountsJSON extends ApiWrappedCollectionJSON {
  accounts: ApiAccountJSON[];
}

export interface WrappedCollectionAccountItem {
  collection_item: CollectionAccountItem;
}

/**
 * Payload types
 */

type CommonPayloadFields = Pick<
  ApiCollectionJSON,
  'name' | 'description' | 'sensitive' | 'discoverable'
> & {
  tag_name?: string | null;
  language?: ApiCollectionJSON['language'];
};

export interface ApiUpdateCollectionPayload extends Partial<CommonPayloadFields> {
  id: string;
}

export interface ApiCreateCollectionPayload extends CommonPayloadFields {
  account_ids?: string[];
}
