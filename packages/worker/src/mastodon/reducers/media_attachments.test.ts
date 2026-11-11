import { fromJS } from 'immutable';

import { STORE_HYDRATE } from '../actions/store';

import media_attachments from './media_attachments';

describe('media_attachments reducer', () => {
  test('starts with no accepted content types', () => {
    expect(media_attachments(undefined, { type: '@@INIT' }).toJS()).toEqual({
      accept_content_types: [],
    });
  });

  test('hydrates the accepted content types', () => {
    const state = media_attachments(undefined, {
      type: STORE_HYDRATE,
      state: fromJS({
        media_attachments: { accept_content_types: ['image/png', '.png'] },
      }),
    });

    expect(state.get('accept_content_types').toArray()).toEqual([
      'image/png',
      '.png',
    ]);
  });

  test('keeps its state when the hydration has none', () => {
    const state = media_attachments(undefined, { type: '@@INIT' });
    expect(
      media_attachments(state, { type: STORE_HYDRATE, state: fromJS({}) }).toJS(),
    ).toEqual({ accept_content_types: [] });
  });
});
