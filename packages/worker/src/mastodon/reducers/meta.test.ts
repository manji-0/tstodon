import { changeLayout, needsReload } from '../actions/app';
import { STORE_HYDRATE } from '../actions/store';
import type { HydrateState, StoreHydrateAction } from '../actions/store';
import { immutableFromJS } from '../utils/immutable_map_of';

import meta from './meta';

const hydrate = (state: HydrateState): StoreHydrateAction => ({
  type: STORE_HYDRATE,
  state: immutableFromJS(state),
});

describe('meta reducer', () => {
  it('starts with the layout and no permissions', () => {
    const state = meta(undefined, { type: 'INIT' });

    expect(state.toJS()).toEqual({
      streaming_api_base_url: null,
      layout: expect.any(String),
      permissions: '0',
      needsReload: false,
    });
  });

  it('hydrates meta without the access token, with the role permissions', () => {
    const state = meta(
      undefined,
      hydrate({
        meta: {
          access_token: 'secret',
          domain: 'example.com',
          me: '1',
          streaming_api_base_url: 'wss://example.com',
          wrapstodon: { year: 2025, state: 'available' },
        },
        role: {
          id: '1',
          name: 'Admin',
          color: '',
          permissions: '1',
          highlighted: true,
        },
      }),
    );

    expect(state.has('access_token')).toBe(false);
    expect(state.get('domain')).toBe('example.com');
    expect(state.get('me')).toBe('1');
    expect(state.get('streaming_api_base_url')).toBe('wss://example.com');
    expect(state.get('permissions')).toBe('1');
    expect(state.get('wrapstodon')?.get('year')).toBe(2025);
  });

  it('has no permissions once hydrated signed out', () => {
    const state = meta(undefined, hydrate({ meta: { domain: 'example.com' } }));

    expect(state.has('permissions')).toBe(true);
    expect(state.get('permissions')).toBeUndefined();
  });

  it('changes the layout', () => {
    const state = meta(undefined, changeLayout({ layout: 'multi-column' }));

    expect(state.get('layout')).toBe('multi-column');
  });

  it('notes that the app needs a reload', () => {
    expect(meta(undefined, needsReload()).get('needsReload')).toBe(true);
  });
});
