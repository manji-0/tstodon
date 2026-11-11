import type { ApiAccountJSON } from 'mastodon/api_types/accounts';
import type { ApiCollectionJSON } from 'mastodon/api_types/collections';
import type { ApiFilterJSON } from 'mastodon/api_types/statuses';
import { createPollFromServerJSON } from 'mastodon/models/poll';
import type { Poll } from 'mastodon/models/poll';
import type { AppDispatch, GetState } from 'mastodon/store';

import { importAccounts } from './accounts';
import { importCustomEmoji } from './emoji';
import { normalizeStatus } from './normalizer';
import type {
  FetchedStatusJSON,
  NormalizedStatus,
  NormalizeStatusOptions,
} from './normalizer';
import { importPolls } from './polls';
import { fetchAccountsForCollectionPreview } from '@/mastodon/reducers/slices/collections';

export const STATUS_IMPORT = 'STATUS_IMPORT' as const;
export const STATUSES_IMPORT = 'STATUSES_IMPORT' as const;
export const FILTERS_IMPORT = 'FILTERS_IMPORT';

export type ImportFetchedStatusesOptions = NormalizeStatusOptions;

function pushUnique<T extends { id: string }>(array: T[], object: T) {
  if (array.every((element) => element.id !== object.id)) {
    array.push(object);
  }
}

export function importStatus(status: NormalizedStatus) {
  return { type: STATUS_IMPORT, status };
}

export function importStatuses(statuses: NormalizedStatus[]) {
  return { type: STATUSES_IMPORT, statuses };
}

export function importFilters(filters: ApiFilterJSON[]) {
  return { type: FILTERS_IMPORT, filters };
}

export function importFetchedAccount(account: ApiAccountJSON) {
  return importFetchedAccounts([account]);
}

export function importFetchedAccounts(accounts: ApiAccountJSON[]) {
  const normalAccounts: ApiAccountJSON[] = [];

  function processAccount(account: ApiAccountJSON) {
    pushUnique(normalAccounts, account);

    if (account.moved) {
      processAccount(account.moved);
    }

    if (account.emojis && account.username === account.acct) {
      void importCustomEmoji(account.emojis);
    }
  }

  accounts.forEach(processAccount);

  return importAccounts({ accounts: normalAccounts });
}

export function importFetchedStatus(
  status: FetchedStatusJSON,
  options: ImportFetchedStatusesOptions = {},
) {
  return importFetchedStatuses([status], options);
}

export function importFetchedStatuses(
  statuses: FetchedStatusJSON[],
  options: ImportFetchedStatusesOptions = {},
) {
  return (dispatch: AppDispatch, getState: GetState) => {
    const accounts: ApiAccountJSON[] = [];
    const normalStatuses: NormalizedStatus[] = [];
    const polls: Poll[] = [];
    const filters: ApiFilterJSON[] = [];
    const collections: ApiCollectionJSON[] = [];

    function processStatus(status: FetchedStatusJSON) {
      pushUnique(
        normalStatuses,
        normalizeStatus(status, getState().statuses.get(status.id), options),
      );
      pushUnique(accounts, status.account);

      if (status.filtered) {
        status.filtered.forEach((result) => {
          pushUnique(filters, result.filter);
        });
      }

      if (status.reblog?.id) {
        processStatus(status.reblog);
      }

      if (
        status.quote &&
        'quoted_status' in status.quote &&
        status.quote.quoted_status
      ) {
        processStatus(status.quote.quoted_status);
      }

      if (status.poll?.id) {
        pushUnique(
          polls,
          createPollFromServerJSON(
            status.poll,
            getState().polls[status.poll.id],
          ),
        );
      }

      if (status.tagged_collections.length) {
        status.tagged_collections.forEach((collection) => {
          pushUnique(collections, collection);
        });
      }

      if (status.card) {
        status.card.authors.forEach((author) => {
          if (author.account) pushUnique(accounts, author.account);
        });
      }

      if (status.emojis && status.account.username === status.account.acct) {
        void importCustomEmoji(status.emojis);
      }
    }

    statuses.forEach(processStatus);

    dispatch(importPolls({ polls }));
    dispatch(importFetchedAccounts(accounts));
    dispatch(importStatuses(normalStatuses));
    dispatch(importFilters(filters));
    void fetchAccountsForCollectionPreview(collections, dispatch);
  };
}
