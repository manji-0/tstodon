import { accountFactoryAPI, statusFactoryAPI } from '@/testing/factories';

import {
  setBrowserPermission,
  setBrowserSupport,
} from '../actions/notifications';

import notifications, { notificationToMap } from './notifications';

describe('notifications reducer', () => {
  test('stores the browser support and permission', () => {
    let state = notifications(undefined, { type: 'INIT' });
    expect(state.toJS()).toEqual({
      browserSupport: false,
      browserPermission: 'default',
    });

    state = notifications(state, setBrowserSupport(true));
    state = notifications(state, setBrowserPermission('granted'));
    expect(state.toJS()).toEqual({
      browserSupport: true,
      browserPermission: 'granted',
    });
  });
});

describe('notificationToMap', () => {
  test('keeps the account and status by id', () => {
    expect(
      notificationToMap({
        id: 'n1',
        type: 'favourite',
        created_at: '2024-01-01T00:00:00.000Z',
        group_key: 'favourite-1',
        account: accountFactoryAPI({ id: 'a' }),
        status: statusFactoryAPI({ id: 's' }),
      }).toJS(),
    ).toEqual({
      id: 'n1',
      type: 'favourite',
      account: 'a',
      created_at: '2024-01-01T00:00:00.000Z',
      status: 's',
      report: null,
      event: null,
      moderation_warning: null,
    });
  });

  test('has no status for a follow', () => {
    expect(
      notificationToMap({
        id: 'n2',
        type: 'follow',
        created_at: '2024-01-01T00:00:00.000Z',
        group_key: 'ungrouped-n2',
        account: accountFactoryAPI({ id: 'a' }),
      }).get('status'),
    ).toBeNull();
  });
});
