import type { ApiWebPushSubscriptionJSON } from '@tstodon/api';
import type { AppDispatch } from 'mastodon/store';

export const SET_BROWSER_SUPPORT = 'PUSH_NOTIFICATIONS_SET_BROWSER_SUPPORT';
export const SET_SUBSCRIPTION = 'PUSH_NOTIFICATIONS_SET_SUBSCRIPTION';
export const CLEAR_SUBSCRIPTION = 'PUSH_NOTIFICATIONS_CLEAR_SUBSCRIPTION';
export const SET_ALERTS = 'PUSH_NOTIFICATIONS_SET_ALERTS';

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

/** `path` in the push notification state, e.g. `['alerts', 'follow']`. */
export function setAlerts (path: readonly string[], value: unknown) {
  return (dispatch: AppDispatch) => {
    dispatch({
      type: SET_ALERTS,
      path,
      value,
    });
  };
}
