import { createReducer } from '@reduxjs/toolkit';
import { Map as ImmutableMap } from 'immutable';

import {
  CLEAR_SUBSCRIPTION,
  SET_ALERTS,
  SET_BROWSER_SUPPORT,
  SET_SUBSCRIPTION,
} from '../actions/push_notifications';
import type {
  SetAlertsAction,
  setBrowserSupport,
  setSubscription,
} from '../actions/push_notifications/setter';
import { STORE_HYDRATE } from '../actions/store';
import type { StoreHydrateAction } from '../actions/store';
import { immutableMapOf } from '../utils/immutable_map_of';
import type { ImmutableMapOf } from '../utils/immutable_map_of';

/** The browser's Web Push subscription, as the server knows it. */
export type PushSubscriptionState = ImmutableMapOf<{
  id: number;
  endpoint: string;
}>;

export interface PushNotificationsShape {
  subscription: PushSubscriptionState | null;
  /** Whether each notification type is pushed (by type). */
  alerts: ImmutableMap<string, boolean>;
  isSubscribed: boolean;
  browserSupport: boolean;
}

export type PushNotificationsState = ImmutableMapOf<PushNotificationsShape>;

const initialState: PushNotificationsState =
  immutableMapOf<PushNotificationsShape>({
    subscription: null,
    alerts: ImmutableMap({
      follow: false,
      follow_request: false,
      favourite: false,
      reblog: false,
      mention: false,
      poll: false,
    }),
    isSubscribed: false,
    browserSupport: false,
  });

export default createReducer(initialState, (builder) => {
  builder
    .addCase(STORE_HYDRATE, (state, action: StoreHydrateAction) => {
      const push_subscription = action.state.get('push_subscription');

      if (push_subscription) {
        return state
          .set(
            'subscription',
            immutableMapOf({
              id: push_subscription.get('id'),
              endpoint: push_subscription.get('endpoint'),
            }),
          )
          .set(
            'alerts',
            push_subscription.get('alerts') || initialState.get('alerts'),
          )
          .set('isSubscribed', true);
      }

      return state;
    })
    .addCase(
      SET_SUBSCRIPTION,
      (state, action: ReturnType<typeof setSubscription>) =>
        state
          .set(
            'subscription',
            immutableMapOf({
              id: action.subscription.id,
              endpoint: action.subscription.endpoint,
            }),
          )
          .set('alerts', ImmutableMap(action.subscription.alerts))
          .set('isSubscribed', true),
    )
    .addCase(
      SET_BROWSER_SUPPORT,
      (state, action: ReturnType<typeof setBrowserSupport>) =>
        state.set('browserSupport', action.value),
    )
    .addCase(CLEAR_SUBSCRIPTION, () => initialState)
    .addCase(SET_ALERTS, (state, action: SetAlertsAction) =>
      state.setIn(action.path, action.value),
    );
});
