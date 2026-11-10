import { z } from "zod";
import { ApiWebSettings } from "../initial-state";

/**
 * `PUT /api/web/settings`: the web UI saves its whole settings object
 * (`ApiWebSettings`, opaque to the server) as `data`.
 */
export const ApiUpdateWebSettingsParamsSchema = z.object({ data: ApiWebSettings });
export type ApiUpdateWebSettingsParams = z.input<typeof ApiUpdateWebSettingsParamsSchema>;

/** The `data` of a web push subscription: which alerts to send, and from whom (`policy`). */
const WebPushSubscriptionData = z.object({
  alerts: z.record(z.string(), z.boolean()).optional(),
  policy: z.string().optional(),
});

/**
 * `POST /api/web/push_subscriptions` (Mastodon's
 * `Api::Web::PushSubscriptionsController`): the browser's `PushSubscription`
 * as `toJSON()` gives it, with `standard` (RFC 8291 payload encryption), and
 * the alerts to start with. The Worker has no such route yet; web push
 * subscriptions go through `/api/v1/push/subscription`.
 */
export const ApiCreateWebPushSubscriptionParamsSchema = z.object({
  subscription: z.object({
    endpoint: z.string(),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string(), auth: z.string() }),
    standard: z.boolean().optional(),
  }),
  data: WebPushSubscriptionData.optional(),
});
export type ApiCreateWebPushSubscriptionParams = z.input<
  typeof ApiCreateWebPushSubscriptionParamsSchema
>;

/** `PUT /api/web/push_subscriptions/:id`: the subscription's new alerts and policy. */
export const ApiUpdateWebPushSubscriptionParamsSchema = z.object({
  data: WebPushSubscriptionData,
});
export type ApiUpdateWebPushSubscriptionParams = z.input<
  typeof ApiUpdateWebPushSubscriptionParamsSchema
>;
