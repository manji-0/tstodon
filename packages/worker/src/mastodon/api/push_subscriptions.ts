import type {
  ApiCreateWebPushSubscriptionParams,
  ApiUpdateWebPushSubscriptionParams,
  ApiWebPushSubscriptionJSON,
} from '@tstodon/api';
import { apiRequest } from 'mastodon/api';

// Mastodon's `/api/web/push_subscriptions`: the session's Web Push
// subscription (`server/routes/web-push-subscriptions.ts`).

export const apiCreateWebPushSubscription = (
  data: ApiCreateWebPushSubscriptionParams,
) =>
  apiRequest<ApiWebPushSubscriptionJSON>('POST', 'web/push_subscriptions', {
    data,
  });

export const apiUpdateWebPushSubscription = (
  id: number | string,
  data: ApiUpdateWebPushSubscriptionParams,
) =>
  apiRequest<ApiWebPushSubscriptionJSON>(
    'PUT',
    `web/push_subscriptions/${id}`,
    { data },
  );
