import { Map as ImmutableMap } from 'immutable';

import type {
  ApiCreateWebPushSubscriptionParams,
  ApiUpdateWebPushSubscriptionParams,
  ApiWebPushSubscriptionJSON,
} from '@tstodon/api';
import {
  apiCreateWebPushSubscription,
  apiUpdateWebPushSubscription,
} from 'mastodon/api/push_subscriptions';
import type { AppDispatch, GetState } from 'mastodon/store';

import { me } from '../../initial_state';
import { pushNotificationsSetting } from '../../settings';
import { decode as decodeBase64 } from '../../utils/base64';

import { setBrowserSupport, setSubscription, clearSubscription } from './setter';

// Taken from https://www.npmjs.com/package/web-push
const urlBase64ToUint8Array = (base64String: string) => {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  return decodeBase64(base64);
};

// The shell renders no `applicationServerKey` when the server has no VAPID key.
const getApplicationServerKey = () => document.querySelector('[name="applicationServerKey"]')?.getAttribute('content') ?? null;

const getRegistration = () => navigator.serviceWorker.ready;

const getPushSubscription = (registration: ServiceWorkerRegistration) =>
  registration.pushManager.getSubscription()
    .then(subscription => ({ registration, subscription }));

const subscribe = (registration: ServiceWorkerRegistration, applicationServerKey: string) =>
  registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(applicationServerKey),
  });

const unsubscribe = ({ registration, subscription }: { registration: ServiceWorkerRegistration, subscription: PushSubscription | null }) =>
  subscription ? subscription.unsubscribe().then(() => registration) : Promise.resolve(registration);

/** The alerts stored for the signed-in account, when they are a map of booleans. */
const isAlerts = (value: unknown): value is Record<string, boolean> =>
  typeof value === 'object' && value !== null && Object.values(value).every(alert => typeof alert === 'boolean');

const sendSubscriptionToBackend = (subscription: PushSubscription) => {
  const { endpoint, expirationTime, keys } = subscription.toJSON();
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;

  if (!endpoint || !p256dh || !auth) {
    return Promise.reject(new Error('The push subscription has no endpoint or keys.'));
  }

  const params: ApiCreateWebPushSubscriptionParams = {
    subscription: { endpoint, expirationTime, keys: { p256dh, auth }, standard: true },
  };

  if (me) {
    const data = pushNotificationsSetting.get(me);
    if (data) {
      params.data = { alerts: isAlerts(data.alerts) ? data.alerts : undefined };
    }
  }

  return apiCreateWebPushSubscription(params);
};

// Last one checks for payload support: https://web-push-book.gauntface.com/chapter-06/01-non-standards-browsers/#no-payload
const supportsPushNotifications = ('serviceWorker' in navigator && 'PushManager' in window && 'getKey' in PushSubscription.prototype);

export function register () {
  return (dispatch: AppDispatch, getState: GetState) => {
    dispatch(setBrowserSupport(supportsPushNotifications));

    if (supportsPushNotifications) {
      const applicationServerKey = getApplicationServerKey();

      if (!applicationServerKey) {
        console.error('The VAPID public key is not set. You will not be able to receive Web Push Notifications.');
        return;
      }

      getRegistration()
        .then(getPushSubscription)
        .then(({ registration, subscription }): Promise<PushSubscription | ApiWebPushSubscriptionJSON> | PushSubscription => {
          if (subscription !== null) {
            // We have a subscription, check if it is still valid
            const currentServerKey = (new Uint8Array(subscription.options.applicationServerKey ?? new ArrayBuffer(0))).toString();
            const subscriptionServerKey = urlBase64ToUint8Array(applicationServerKey).toString();
            const serverEndpoint = getState().push_notifications.getIn(['subscription', 'endpoint']);

            // If the VAPID public key did not change and the endpoint corresponds
            // to the endpoint saved in the backend, the subscription is valid
            if (subscriptionServerKey === currentServerKey && subscription.endpoint === serverEndpoint) {
              return subscription;
            } else {
              // Something went wrong, try to subscribe again
              return unsubscribe({ registration, subscription }).then(registration => subscribe(registration, applicationServerKey)).then(
                subscription => sendSubscriptionToBackend(subscription));
            }
          }

          // No subscription, try to subscribe
          return subscribe(registration, applicationServerKey).then(
            subscription => sendSubscriptionToBackend(subscription));
        })
        .then(subscription => {
          // If we got a PushSubscription (and not a subscription object from the backend)
          // it means that the backend subscription is valid (and was set during hydration)
          if (!(subscription instanceof PushSubscription)) {
            dispatch(setSubscription(subscription));
            if (me) {
              pushNotificationsSetting.set(me, { alerts: subscription.alerts });
            }
          }
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.code === 20 && error.name === 'AbortError') {
            console.warn('Your browser supports Web Push Notifications, but does not seem to implement the VAPID protocol.');
          } else if (error instanceof DOMException && error.code === 5 && error.name === 'InvalidCharacterError') {
            console.error('The VAPID public key seems to be invalid:', applicationServerKey);
          }

          // Clear alerts and hide UI settings
          dispatch(clearSubscription());
          if (me) {
            pushNotificationsSetting.remove(me);
          }

          return getRegistration()
            .then(getPushSubscription)
            .then(unsubscribe);
        })
        .catch(console.warn);
    } else {
      console.warn('Your browser does not support Web Push Notifications.');
    }
  };
}

export function saveSettings() {
  return (_: AppDispatch, getState: GetState) => {
    const state = getState().push_notifications;
    const subscriptionId = state.getIn(['subscription', 'id']);
    const alerts = state.get('alerts');

    // Nothing to save before the browser is subscribed.
    if (typeof subscriptionId !== 'number' && typeof subscriptionId !== 'string') {
      return;
    }

    const data = {
      alerts: ImmutableMap.isMap(alerts)
        ? Object.fromEntries(alerts.toArray().flatMap(([type, alert]) => typeof type === 'string' && typeof alert === 'boolean' ? [[type, alert]] : []))
        : {},
    } satisfies ApiUpdateWebPushSubscriptionParams['data'];

    apiUpdateWebPushSubscription(subscriptionId, {
      data,
    }).then(() => {
      if (me) {
        pushNotificationsSetting.set(me, data);
      }
    }).catch(console.warn);
  };
}
