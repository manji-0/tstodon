import type { ApiStatusEditJSON } from '@tstodon/api';

import {
  fetchHistoryFail,
  fetchHistoryRequest,
  fetchHistorySuccess,
} from '../actions/history';

import history from './history';

const account = {
  id: '1',
  username: 'alice',
  acct: 'alice',
} as const;

const edit = (content: string, created_at: string) => ({
  content,
  spoiler_text: '',
  sensitive: false,
  created_at,
  account,
  poll: { options: [{ title: 'a' }] },
  media_attachments: [],
  emojis: [{ shortcode: 'x', url: 'u', static_url: 's', visible_in_picker: true }],
});

describe('history reducer', () => {
  test('starts empty', () => {
    expect(history(undefined, { type: '@@INIT' }).toJS()).toEqual({});
  });

  test('loads the edits of a status, newest first', () => {
    let state = history(undefined, fetchHistoryRequest('10'));
    expect(state.get('10')?.toJS()).toEqual({ loading: true, items: [] });

    const edits = [
      edit('first', '2024-01-01T00:00:00.000Z'),
      edit('second', '2024-01-02T00:00:00.000Z'),
    ];
    // The fixture leaves out the account fields the reducer drops.
    state = history(state, {
      ...fetchHistorySuccess('10', []),
      history: edits,
    });

    const entry = state.get('10');
    expect(entry?.get('loading')).toBe(false);
    expect(entry?.toJS()).toEqual({
      loading: false,
      items: [
        { ...edits[1], account: '1', original: false },
        { ...edits[0], account: '1', original: true },
      ],
    });
    // Nested values are Immutable collections, as `fromJS` built them.
    expect(entry?.getIn(['items', 0, 'poll', 'options', 0, 'title'])).toBe('a');
    expect(entry?.getIn(['items', 0, 'emojis', 0, 'shortcode'])).toBe('x');

    state = history(state, fetchHistoryRequest('10'));
    expect(state.get('10')?.toJS()).toEqual({ loading: true, items: [] });
  });

  test('stops loading on failure and keeps other statuses', () => {
    let state = history(undefined, fetchHistoryRequest('10'));
    state = history(state, fetchHistoryRequest('11'));
    state = history(state, fetchHistoryFail('10', new Error('x')));

    expect(state.get('10')?.get('loading')).toBe(false);
    expect(state.get('11')?.get('loading')).toBe(true);
  });

  test('ignores other actions', () => {
    const state = history(undefined, fetchHistoryRequest('10'));
    expect(history(state, { type: 'OTHER' })).toBe(state);
  });
});

export type { ApiStatusEditJSON };
