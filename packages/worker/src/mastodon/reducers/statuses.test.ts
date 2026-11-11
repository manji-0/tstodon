import { Map as ImmutableMap, fromJS } from 'immutable';

import {
  imageAttachmentFactoryAPI,
  statusFactoryAPI,
} from '@/testing/factories';

import { importStatus, importStatuses } from '../actions/importer';
import { normalizeStatus } from '../actions/importer/normalizer';
import {
  bookmarkRequest,
  favouriteFail,
  favouriteRequest,
} from '../actions/interactions';
import { reblog } from '../actions/interactions_typed';
import {
  fetchStatusFail,
  fetchStatusRequest,
  hideStatus,
  revealStatus,
  translateStatusSuccess,
  undoStatusTranslation,
} from '../actions/statuses';
import { setStatusQuotePolicy } from '../actions/statuses_typed';
import { timelineDelete } from '../actions/timelines_typed';
import type { ApiQuotePolicyJSON } from '../api_types/quotes';
import type { Status } from '../models/status';

import statuses from './statuses';
import type { StatusesState } from './statuses';

const normalized = (
  id: string,
  data: Parameters<typeof statusFactoryAPI>[0] = {},
) => normalizeStatus(statusFactoryAPI({ id, ...data }), undefined, {});

const withStatuses = (...ids: string[]): StatusesState =>
  statuses(undefined, importStatuses(ids.map((id) => normalized(id))));

const stored = (state: StatusesState, id: string): Status => {
  const status = state.get(id);
  if (!status) throw new Error(`status ${id} is not in the state`);
  return status;
};

describe('statuses reducer', () => {
  test('starts empty', () => {
    expect(statuses(undefined, { type: 'INIT' })).toEqual(ImmutableMap());
  });

  test('imports a normalized status as an Immutable map', () => {
    const status = normalized('1', { text: 'Hello' });
    const state = statuses(undefined, importStatus(status));

    expect(stored(state, '1')).toEqual(fromJS(status));
    expect(state.getIn(['1', 'account'])).toBe(status.account);
  });

  test('imports several statuses', () => {
    expect(withStatuses('1', '2').keySeq().toArray()).toEqual(['1', '2']);
  });

  test('marks a favourite as requested, and only reverts a known status', () => {
    const state = withStatuses('1');
    const status = stored(state, '1');

    const favourited = statuses(state, favouriteRequest(status));
    expect(favourited.getIn(['1', 'favourited'])).toBe(true);

    expect(
      statuses(favourited, favouriteFail(status, new Error())).getIn([
        '1',
        'favourited',
      ]),
    ).toBe(false);

    const empty = statuses(undefined, { type: 'INIT' });
    expect(statuses(empty, favouriteFail(status, new Error()))).toBe(empty);
  });

  test('does not bookmark a status that is not in the store', () => {
    const state = withStatuses('1');
    const other = ImmutableMap<string, unknown>({ id: '2' });
    expect(statuses(state, bookmarkRequest(other))).toBe(state);
  });

  test('sets reblogged while a reblog is pending', () => {
    const state = statuses(
      withStatuses('1'),
      reblog.pending('request', { statusId: '1' }),
    );
    expect(state.getIn(['1', 'reblogged'])).toBe(true);
  });

  test('keeps a fetched stub loading, and removes it when the fetch fails', () => {
    const loading = statuses(undefined, fetchStatusRequest('9', false));
    expect(loading.get('9')?.toJS()).toEqual({ isLoading: true });

    expect(
      statuses(loading, fetchStatusFail('9', new Error(), false)).has('9'),
    ).toBe(false);
  });

  test('marks the quote deleted when a quoted status is not found', () => {
    const state = statuses(
      withStatuses('1'),
      fetchStatusFail('9', { status: 404 }, false, '1'),
    );
    expect(state.getIn(['1', 'quote', 'state'])).toBe('deleted');
  });

  test('only clears the loading flag of a fetched status', () => {
    const state = statuses(withStatuses('1'), fetchStatusRequest('1', false));
    const failed = statuses(state, fetchStatusFail('1', new Error(), false));
    expect(failed.has('1')).toBe(true);
    expect(failed.getIn(['1', 'isLoading'])).toBeUndefined();
  });

  test('hides and reveals the known statuses', () => {
    const hidden = statuses(withStatuses('1', '2'), hideStatus(['1', '3']));
    expect(hidden.getIn(['1', 'hidden'])).toBe(true);
    expect(hidden.has('3')).toBe(false);

    expect(statuses(hidden, revealStatus('1')).getIn(['1', 'hidden'])).toBe(
      false,
    );
  });

  test('deletes a status and its reblogs', () => {
    const state = statuses(
      withStatuses('1', '2', '3'),
      timelineDelete({
        statusId: '1',
        accountId: 'a',
        references: ['2'],
        reblogOf: null,
      }),
    );
    expect(state.keySeq().toArray()).toEqual(['3']);
  });

  test('stores a translation and undoes it', () => {
    const state = statuses(
      undefined,
      importStatus(
        normalized('1', {
          media_attachments: [
            imageAttachmentFactoryAPI({ id: 'm1', description: 'A cat' }),
            imageAttachmentFactoryAPI({ id: 'm2', description: 'A dog' }),
          ],
        }),
      ),
    );

    const translated = statuses(
      state,
      translateStatusSuccess('1', {
        content: '<p>Bonjour</p>',
        spoiler_text: '',
        language: 'fr',
        detected_source_language: 'en',
        provider: 'Test',
        media_attachments: [
          { id: 'm1', description: 'Un chat' },
          { id: 'unknown', description: 'Rien' },
        ],
      }),
    );

    expect(translated.getIn(['1', 'translation', 'contentHtml'])).toBe(
      '<p>Bonjour</p>',
    );
    expect(
      translated.getIn(['1', 'media_attachments', 0, 'translation']),
    ).toEqual(fromJS({ description: 'Un chat' }));
    // An attachment the status does not have is not written to its last one.
    expect(
      translated.getIn(['1', 'media_attachments', 1, 'translation']),
    ).toBeUndefined();

    const undone = statuses(translated, undoStatusTranslation('1', undefined));
    expect(undone.getIn(['1', 'translation'])).toBeUndefined();
    expect(
      undone.getIn(['1', 'media_attachments', 0, 'translation']),
    ).toBeUndefined();
  });

  test('ignores a translation of a status no longer in the store', () => {
    const state = withStatuses('1');
    expect(
      statuses(
        state,
        translateStatusSuccess('2', {
          content: '',
          spoiler_text: '',
          language: 'fr',
          detected_source_language: 'en',
          provider: 'Test',
        }),
      ),
    ).toBe(state);
  });

  test('stores a saved quote policy', () => {
    const state = withStatuses('1');
    const saving = statuses(
      state,
      setStatusQuotePolicy.pending('request', {
        statusId: '1',
        policy: 'nobody',
      }),
    );
    expect(saving.getIn(['1', 'isSavingQuotePolicy'])).toBe(true);

    const quoteApproval: ApiQuotePolicyJSON = {
      automatic: [],
      manual: [],
      current_user: 'denied',
    };
    const saved = statuses(
      saving,
      setStatusQuotePolicy.fulfilled(
        statusFactoryAPI({ id: '1', quote_approval: quoteApproval }),
        'request',
        { statusId: '1', policy: 'nobody' },
      ),
    );
    expect(saved.getIn(['1', 'quote_approval'])).toEqual(quoteApproval);
    expect(saved.getIn(['1', 'isSavingQuotePolicy'])).toBeUndefined();
  });
});
