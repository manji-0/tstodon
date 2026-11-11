import type { RecordOf } from 'immutable';

import type { ApiCollectionJSON } from '@/mastodon/api_types/collections';
import type { ApiCustomEmojiJSON } from '@/mastodon/api_types/custom_emoji';
import type {
  ApiAudioAttachmentJSON,
  ApiGifvAttachmentJSON,
  ApiImageAttachmentJSON,
  ApiMediaAttachmentJSON,
  ApiUnknownAttachmentJSON,
  ApiVideoAttachmentJSON,
  MediaAttachmentType,
} from '@/mastodon/api_types/media_attachments';
import type {
  ApiQuoteJSON,
  ApiQuotePolicyJSON,
} from '@/mastodon/api_types/quotes';
import type {
  ApiFilterResultJSON,
  ApiMentionJSON,
  ApiPreviewCardAuthorJSON,
  ApiPreviewCardJSON,
  ApiStatusTranslationJSON,
  ApiTagJSON,
  StatusVisibility,
} from '@/mastodon/api_types/statuses';

import type {
  NormalizedMediaAttachment,
  NormalizedStatus,
} from '@/mastodon/actions/importer/normalizer';
import type {
  ImmutableMapOf,
  ImmutableMapReaderOf,
  ImmutableOf,
} from '@/mastodon/utils/immutable_map_of';

import type { Account, AccountShapeFull } from './account';
import type { Poll } from './poll';

export type { StatusVisibility } from '@/mastodon/api_types/statuses';

/**
 * A status as the statuses reducer stores it, before `fromJS`: the
 * importer's `NormalizedStatus` (the account, the boosted status, the poll
 * and a quote's status by id), plus the flags the reducer sets on it.
 */
export type StatusJSON = NormalizedStatus & {
  /**
   * Set while the status is fetched. For an id not in the store yet the
   * reducer stores a stub of this field alone (`{ isLoading: true }`), which
   * this type does not describe: `makeGetStatus` reports it as loading.
   */
  isLoading?: boolean;
  /** Toggled by the "show more" of a long status. */
  collapsed?: boolean;
  /** Set while a new quote policy is saved. */
  isSavingQuotePolicy?: boolean;
};

/**
 * The fields of a stored status: `StatusJSON`'s through `fromJS` (the
 * attachments, mentions, tags, emojis, card, filter results, quote and
 * quote policy as Immutable values).
 */
export type StatusFields = {
  [K in keyof StatusJSON]: ImmutableOf<StatusJSON[K]>;
};

/** A status in the store (`state.statuses`), typed per field. */
export type Status = ImmutableMapOf<StatusFields>;

/**
 * A stored status with some fields in another form: `StatusWith<{ account:
 * Account }>` is one whose account is the account itself, as
 * `immutableMapWith(status, 'account', account)` makes it.
 */
export type StatusWith<Fields extends object> = ImmutableMapOf<
  Omit<StatusFields, keyof Fields> & Fields
>;

/**
 * A boosted status as `makeGetStatus` gives it (the `reblog` of an
 * `ExpandedStatus`): its account is the account itself.
 */
export type ExpandedReblog = StatusWith<{ account: Account }>;

/**
 * A status as `makeGetStatus` (`selectors/index.js`) gives it: the stored
 * status with its account and boosted status in place of their ids, and the
 * titles of the filters it matched (`false` for none).
 */
export type ExpandedStatus = StatusWith<{
  account: Account;
  reblog: ExpandedReblog | null;
  matched_filters: string[] | false;
  matched_media_filters: string[] | false;
}>;

/**
 * Any form of a status, for a reader of its own fields: a stored `Status`,
 * an `ExpandedStatus`, or one with its account or poll in place of the id
 * (the reply and redraft actions carry those).
 */
export type AnyStatus = ImmutableMapReaderOf<
  Omit<StatusFields, 'account' | 'reblog' | 'poll'> & {
    account: string | Account | undefined;
    reblog: string | ExpandedReblog | null | undefined;
    poll: string | Poll | null | undefined;
  }
>;

export interface StatusShape {
  id: string;
  account: string;
  created_at: string;
  edited_at?: string | null;
  application: {
    name: string;
    website?: string | null;
  };
  hidden: boolean;
  language: string | null;
  muted: boolean;
  pinned: boolean;
  filtered: FilterResult[];
  sensitive: boolean;
  collapsed: boolean | null;
  uri: string;
  url: string | null;
  isLoading?: boolean;

  // Content
  content: string;
  contentHtml: string;
  in_reply_to_account_id?: string | null;
  in_reply_to_id?: string | null;
  search_index?: string;
  spoilerHtml?: string;
  spoiler_text?: string;

  // Embeds
  card?: CardShape | null;
  emojis: Pick<ApiCustomEmojiJSON, 'shortcode' | 'static_url' | 'url'>[];
  media_attachments: MediaAttachmentShape[];
  mentions: ApiMentionJSON[];
  poll?: string;
  quote?: Omit<ApiQuoteJSON, 'quoted_status'> & {
    quoted_status?: string;
  };
  reblog?: string;
  tagged_collections: ApiCollectionJSON[];
  tags: ApiTagJSON[];
  translation?: StatusTranslation;

  // Interactions
  bookmarked: boolean;
  favourited: boolean;
  favourites_count: number;
  quote_approval: ApiQuotePolicyJSON | null;
  quotes_count: number;
  reblogged: boolean;
  reblogs_count: number;
  replies_count: number;
  visibility: StatusVisibility;
}
export type ExpandedStatusShape = Omit<StatusShape, 'account' | 'reblog'> & {
  account: AccountShapeFull;
  reblog?: Omit<ExpandedStatusShape, 'reblog'>;
};

export type CardShape = Omit<ApiPreviewCardJSON, 'authors'> & {
  authors: (Omit<ApiPreviewCardAuthorJSON, 'author'> & {
    accountId?: string;
  })[];
};

export type Card = RecordOf<CardShape>;

/** An attachment of a stored status. */
export type MediaAttachment = ImmutableOf<NormalizedMediaAttachment>;

/** The fields of a stored status's attachment. */
export type MediaAttachmentFields =
  MediaAttachment extends ImmutableMapOf<infer Fields> ? Fields : never;

export type MediaAttachmentShape<
  TAttachmentJSON extends ApiMediaAttachmentJSON = ApiMediaAttachmentJSON,
> = Omit<TAttachmentJSON, 'remote_url'> & {
  remote_url: string | null;
  translation?: {
    description: string;
  };
};

export function isMediaAttachmentOfType(
  attachment: MediaAttachmentShape,
  type: 'image',
): attachment is MediaAttachmentShape<ApiImageAttachmentJSON>;
export function isMediaAttachmentOfType(
  attachment: MediaAttachmentShape,
  type: 'video',
): attachment is MediaAttachmentShape<ApiVideoAttachmentJSON>;
export function isMediaAttachmentOfType(
  attachment: MediaAttachmentShape,
  type: 'gifv',
): attachment is MediaAttachmentShape<ApiGifvAttachmentJSON>;
export function isMediaAttachmentOfType(
  attachment: MediaAttachmentShape,
  type: 'audio',
): attachment is MediaAttachmentShape<ApiAudioAttachmentJSON>;
export function isMediaAttachmentOfType(
  attachment: MediaAttachmentShape,
  type: 'unknown',
): attachment is MediaAttachmentShape<ApiUnknownAttachmentJSON>;
export function isMediaAttachmentOfType(
  attachment: MediaAttachmentShape,
  type: MediaAttachmentType,
) {
  return attachment.type === type;
}

export type CollectionAttachment = RecordOf<ApiCollectionJSON>;

export type FilterResult = Omit<ApiFilterResultJSON, 'filter'> & {
  filter: string;
};

export type StatusTranslation = Omit<ApiStatusTranslationJSON, 'poll'>;
