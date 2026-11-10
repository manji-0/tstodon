import escapeTextContentForBrowser from 'escape-html';
import type { Map as ImmutableMap } from 'immutable';
import { isList, isMap } from 'immutable';

import type {
  ApiQuotedStatusJSON,
  ApiShallowQuoteJSON,
  ApiTranslationJSON,
} from '@tstodon/api';
import type { ApiAnnouncementJSON } from 'mastodon/api_types/announcements';
import type { ApiMediaAttachmentJSON } from 'mastodon/api_types/media_attachments';
import type { ApiQuoteJSON } from 'mastodon/api_types/quotes';
import type {
  ApiFilterResultJSON,
  ApiPreviewCardAuthorJSON,
  ApiPreviewCardJSON,
  ApiStatusJSON,
} from 'mastodon/api_types/statuses';
import type { FilterResult, Status } from 'mastodon/models/status';

import { expandSpoilers } from '../../initial_state';

import { importCustomEmoji } from './emoji';

const domParser = new DOMParser();

/**
 * A status as the API sends it: a timeline's, or one shown inside a quote,
 * whose own quote names its status by id only.
 */
export type FetchedStatusJSON = ApiStatusJSON | ApiQuotedStatusJSON;

/** A quote with its status replaced by the status's id. */
export type NormalizedQuote =
  | (Omit<ApiQuoteJSON, 'quoted_status'> & { quoted_status: string | null })
  | (ApiShallowQuoteJSON & { quoted_status?: string });

export type NormalizedMediaAttachment = ApiMediaAttachmentJSON & {
  /** Carried over from the stored attachment while its description is the same. */
  translation?: unknown;
};

export type NormalizedCard = Omit<ApiPreviewCardJSON, 'authors'> & {
  authors: (ApiPreviewCardAuthorJSON & {
    accountId: string | undefined;
    account: undefined;
  })[];
};

/**
 * A status as the statuses reducer stores it (before `fromJS`): the
 * account, boosted status and poll by id, and the derived HTML and search
 * text. The translation and quote policy carried over from the stored
 * status are as stored (Immutable).
 */
export type NormalizedStatus = Omit<
  FetchedStatusJSON,
  | 'account'
  | 'reblog'
  | 'quote'
  | 'poll'
  | 'card'
  | 'filtered'
  | 'media_attachments'
  | 'quote_approval'
> & {
  account: string;
  reblog?: string | null;
  quote?: NormalizedQuote | null;
  poll: string | null;
  card: NormalizedCard | null;
  filtered?: FilterResult[];
  media_attachments: NormalizedMediaAttachment[];
  quote_approval:
    | FetchedStatusJSON['quote_approval']
    | ImmutableMap<unknown, unknown>
    | null;
  search_index?: string | null;
  contentHtml?: string;
  spoilerHtml?: string;
  hidden?: boolean;
  translation?: unknown;
};

export interface NormalizeStatusOptions {
  bogusQuotePolicy?: boolean;
}

const searchContentOf = (status: FetchedStatusJSON, spoilerText: string) =>
  [spoilerText, status.content]
    .concat(
      status.poll?.options
        ? status.poll.options.map((option) => option.title)
        : [],
    )
    .concat(status.media_attachments.map((att) => att.description ?? ''))
    .join('\n\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/p><p>/g, '\n\n');

export function searchTextFromRawStatus(status: FetchedStatusJSON) {
  const spoilerText = status.spoiler_text || '';
  return domParser.parseFromString(
    searchContentOf(status, spoilerText),
    'text/html',
  ).documentElement.textContent;
}

export function normalizeFilterResult(
  result: ApiFilterResultJSON,
): FilterResult {
  return { ...result, filter: result.filter.id };
}

function stripQuoteFallback(text: string) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = text;

  wrapper.querySelector('.quote-inline')?.remove();

  return wrapper.innerHTML;
}

function normalizeQuote(
  quote: FetchedStatusJSON['quote'],
): NormalizedQuote | null | undefined {
  if (!quote) {
    return quote;
  }

  if ('quoted_status_id' in quote) {
    return quote.quoted_status_id
      ? { ...quote, quoted_status: quote.quoted_status_id }
      : quote;
  }

  return quote.quoted_status
    ? { ...quote, quoted_status: quote.quoted_status.id }
    : quote;
}

const isHttpUrl = (url: string) =>
  url.startsWith('http://') || url.startsWith('https://');

export function normalizeStatus(
  status: FetchedStatusJSON,
  normalOldStatus: Status | undefined,
  { bogusQuotePolicy = false }: NormalizeStatusOptions,
): NormalizedStatus {
  const {
    account,
    reblog,
    quote,
    poll,
    card,
    filtered,
    media_attachments,
    quote_approval,
    ...fields
  } = status;

  const normalStatus: NormalizedStatus = {
    ...fields,
    account: account.id,
    ...(reblog === undefined ? {} : { reblog: reblog?.id ?? null }),
    ...(quote === undefined ? {} : { quote: normalizeQuote(quote) }),
    poll: poll?.id ?? null,
    card: card
      ? {
          ...card,
          authors: card.authors.map((author) => ({
            ...author,
            accountId: author.account?.id,
            account: undefined,
          })),
        }
      : null,
    ...(filtered ? { filtered: filtered.map(normalizeFilterResult) } : {}),
    media_attachments,
    quote_approval: bogusQuotePolicy ? null : quote_approval,
  };

  // Only calculate these values when status first encountered and
  // when the underlying values change. Otherwise keep the ones
  // already in the reducer
  if (
    normalOldStatus &&
    normalOldStatus.get('content') === normalStatus.content &&
    normalOldStatus.get('spoiler_text') === normalStatus.spoiler_text
  ) {
    const searchIndex = normalOldStatus.get('search_index');
    const contentHtml = normalOldStatus.get('contentHtml');
    const spoilerHtml = normalOldStatus.get('spoilerHtml');
    const hidden = normalOldStatus.get('hidden');

    if (typeof searchIndex === 'string')
      normalStatus.search_index = searchIndex;
    if (typeof contentHtml === 'string') normalStatus.contentHtml = contentHtml;
    if (typeof spoilerHtml === 'string') normalStatus.spoilerHtml = spoilerHtml;
    if (typeof hidden === 'boolean') normalStatus.hidden = hidden;

    if (normalOldStatus.get('translation')) {
      normalStatus.translation = normalOldStatus.get('translation');
    }
  } else {
    // If the status has a CW but no contents, treat the CW as if it were the
    // status' contents, to avoid having a CW toggle with seemingly no effect.
    if (
      normalStatus.spoiler_text &&
      !normalStatus.content &&
      !normalStatus.quote
    ) {
      normalStatus.content = normalStatus.spoiler_text;
      normalStatus.spoiler_text = '';
    }

    const spoilerText = normalStatus.spoiler_text || '';

    normalStatus.search_index = domParser.parseFromString(
      searchContentOf(status, spoilerText),
      'text/html',
    ).documentElement.textContent;
    normalStatus.contentHtml = normalStatus.content;
    normalStatus.spoilerHtml = escapeTextContentForBrowser(spoilerText);
    normalStatus.hidden = expandSpoilers
      ? false
      : spoilerText.length > 0 || normalStatus.sensitive;

    // Remove quote fallback link from the DOM so it doesn't mess with paragraph margins
    if (normalStatus.quote) {
      normalStatus.contentHtml = stripQuoteFallback(normalStatus.contentHtml);
    }

    if (normalStatus.url && !isHttpUrl(normalStatus.url)) {
      normalStatus.url = null;
    }

    normalStatus.url ||= normalStatus.uri;

    normalStatus.media_attachments = normalStatus.media_attachments.map(
      (item) =>
        item.remote_url && !isHttpUrl(item.remote_url)
          ? { ...item, remote_url: null }
          : item,
    );
  }

  if (normalOldStatus) {
    if (!normalStatus.quote_approval) {
      const oldQuoteApproval = normalOldStatus.get('quote_approval');
      normalStatus.quote_approval = isMap(oldQuoteApproval)
        ? oldQuoteApproval
        : null;
    }

    const list = normalOldStatus.get('media_attachments');
    if (isList(list)) {
      normalStatus.media_attachments = normalStatus.media_attachments.map(
        (item) => {
          const oldItem = list.find((i) => isMap(i) && i.get('id') === item.id);
          return isMap(oldItem) &&
            oldItem.get('description') === item.description
            ? { ...item, translation: oldItem.get('translation') }
            : item;
        },
      );
    }
  }

  return normalStatus;
}

export function normalizeStatusTranslation(
  translation: ApiTranslationJSON,
  status: Status,
) {
  const normalTranslation = {
    detected_source_language: translation.detected_source_language,
    language: translation.language,
    provider: translation.provider,
    contentHtml: translation.content,
    spoilerHtml: escapeTextContentForBrowser(translation.spoiler_text),
    spoiler_text: translation.spoiler_text,
  };

  // Remove quote fallback link from the DOM so it doesn't mess with paragraph margins
  if (status.get('quote')) {
    normalTranslation.contentHtml = stripQuoteFallback(
      normalTranslation.contentHtml,
    );
  }

  return normalTranslation;
}

export function normalizeAnnouncement(announcement: ApiAnnouncementJSON) {
  const normalAnnouncement = {
    ...announcement,
    contentHtml: announcement.content,
  };

  if (normalAnnouncement.emojis) {
    void importCustomEmoji(normalAnnouncement.emojis);
  }

  return normalAnnouncement;
}
