import type {
  ApiCreateWebPushSubscriptionParams,
  ApiUpdateWebPushSubscriptionParams,
  ApiWebPushSubscriptionJSON,
} from '@tstodon/api';
import { apiRequest } from 'mastodon/api';

// Mastodon's `/api/web/push_subscriptions`, which the Worker does not serve
// yet (see `packages/worker/src/UPSTREAM.md`).

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
