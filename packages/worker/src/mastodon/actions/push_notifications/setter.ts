import type { ApiWebPushSubscriptionJSON } from '@tstodon/api';
import type { AppDispatch } from 'mastodon/store';

export const SET_BROWSER_SUPPORT = 'PUSH_NOTIFICATIONS_SET_BROWSER_SUPPORT' as const;
export const SET_SUBSCRIPTION = 'PUSH_NOTIFICATIONS_SET_SUBSCRIPTION' as const;
export const CLEAR_SUBSCRIPTION = 'PUSH_NOTIFICATIONS_CLEAR_SUBSCRIPTION' as const;
export const SET_ALERTS = 'PUSH_NOTIFICATIONS_SET_ALERTS' as const;

export function setBrowserSupport (value: boolean) {
  return {
    type: SET_BROWSER_SUPPORT,
    value,
  };
}

export function setSubscription (subscription: ApiWebPushSubscriptionJSON) {
  return {
    type: SET_SUBSCRIPTION,
    subscription,
  };
}

export function clearSubscription () {
  return {
    type: CLEAR_SUBSCRIPTION,
  };
}

/** `SET_ALERTS`: `path` in the push notification state, e.g. `['alerts', 'follow']`. */
export type SetAlertsAction = {
  type: typeof SET_ALERTS;
  path: readonly string[];
  value: unknown;
};

export function setAlerts (path: readonly string[], value: unknown) {
  return (dispatch: AppDispatch) => {
    dispatch({
      type: SET_ALERTS,
      path,
      value,
    } satisfies SetAlertsAction);
  };
}
