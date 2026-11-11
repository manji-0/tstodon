import { Map as ImmutableMap } from 'immutable';

import type { ApiWebPushSubscriptionJSON } from '@tstodon/api';

import {
  CLEAR_SUBSCRIPTION,
  SET_ALERTS,
} from '../actions/push_notifications';
import {
  clearSubscription,
  setBrowserSupport,
  setSubscription,
} from '../actions/push_notifications/setter';
import type { SetAlertsAction } from '../actions/push_notifications/setter';
import { STORE_HYDRATE } from '../actions/store';
import type { HydrateState, StoreHydrateAction } from '../actions/store';
import { immutableFromJS } from '../utils/immutable_map_of';

import pushNotifications from './push_notifications';

const subscription: ApiWebPushSubscriptionJSON = {
  id: 1,
  endpoint: 'https://push.example/1',
  standard: true,
  alerts: { follow: true, mention: false },
  policy: 'all',
  server_key: 'key',
};

const hydrate = (state: HydrateState): StoreHydrateAction => ({
  type: STORE_HYDRATE,
  state: immutableFromJS(state),
});

const initialAlerts = {
  follow: false,
  follow_request: false,
  favourite: false,
  reblog: false,
  mention: false,
  poll: false,
};

describe('push_notifications reducer', () => {
  it('starts unsubscribed', () => {
    expect(pushNotifications(undefined, { type: 'INIT' }).toJS()).toEqual({
      subscription: null,
      alerts: initialAlerts,
      isSubscribed: false,
      browserSupport: false,
    });
  });

  it('hydrates the subscription', () => {
    const state = pushNotifications(
      undefined,
      hydrate({ push_subscription: subscription }),
    );

    expect(state.toJS()).toEqual({
      subscription: { id: 1, endpoint: 'https://push.example/1' },
      alerts: { follow: true, mention: false },
      isSubscribed: true,
      browserSupport: false,
    });
  });

  it('keeps the state when hydrated without a subscription', () => {
    const initial = pushNotifications(undefined, { type: 'INIT' });

    expect(
      pushNotifications(initial, hydrate({ push_subscription: null })),
    ).toBe(initial);
  });

  it('sets a subscription', () => {
    const state = pushNotifications(undefined, setSubscription(subscription));

    expect(state.get('subscription')?.toJS()).toEqual({
      id: 1,
      endpoint: 'https://push.example/1',
    });
    expect(state.get('alerts')).toEqual(
      ImmutableMap({ follow: true, mention: false }),
    );
    expect(state.get('isSubscribed')).toBe(true);
  });

  it('sets the browser support and an alert', () => {
    let state = pushNotifications(undefined, setBrowserSupport(true));
    const setAlert: SetAlertsAction = {
      type: SET_ALERTS,
      path: ['alerts', 'poll'],
      value: true,
    };
    state = pushNotifications(state, setAlert);

    expect(state.get('browserSupport')).toBe(true);
    expect(state.get('alerts').get('poll')).toBe(true);
  });

  it('clears the subscription back to the initial state', () => {
    const initial = pushNotifications(undefined, { type: 'INIT' });
    const state = pushNotifications(initial, setSubscription(subscription));

    expect(clearSubscription().type).toBe(CLEAR_SUBSCRIPTION);
    expect(pushNotifications(state, clearSubscription())).toBe(initial);
  });
});
