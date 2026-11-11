import type { StreamChannelValue, StreamDeliveryValue, StreamEventValue } from "@tstodon/domain";

const hubStub = (env: Env, hub: string) => env.STREAM_HUB.get(env.STREAM_HUB.idFromName(hub));

/**
 * Hand an event to the sockets of one hub (see `hubName`) subscribed to its
 * channels, for a hub found by its `stream_subscriptions` rows for them.
 */
export const publishToHub = async (
  env: Env,
  hub: string,
  delivery: StreamDeliveryValue,
): Promise<void> => {
  await hubStub(env, hub).publish(hub, delivery, true);
};

/**
 * An event on the account's `user` stream. Notifications also go to
 * `user:notification`, which carries nothing else.
 */
export const publishToAccount = async (
  env: Env,
  accountId: string,
  event: StreamEventValue,
): Promise<void> => {
  const channels: StreamChannelValue[] =
    event.kind === "notification" || event.kind === "notifications_merged"
      ? [{ kind: "User" }, { kind: "UserNotification" }]
      : [{ kind: "User" }];
  await hubStub(env, accountId).publish(accountId, { channels, event }, false);
};
