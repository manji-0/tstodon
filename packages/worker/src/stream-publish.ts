import type { StreamChannelValue, StreamDeliveryValue, StreamEventValue } from "@tstodon/domain";

/** Hand an event to the sockets of one hub (see `hubName`) subscribed to its channels. */
export const publishToHub = async (
  env: Env,
  hub: string,
  delivery: StreamDeliveryValue,
): Promise<void> => {
  const stub = env.STREAM_HUB.get(env.STREAM_HUB.idFromName(hub));
  await stub.publish(delivery);
};

/**
 * An event on the account's `user` stream. Notifications also go to
 * `user:notification`, which carries nothing else.
 */
export const publishToAccount = (
  env: Env,
  accountId: string,
  event: StreamEventValue,
): Promise<void> => {
  const channels: StreamChannelValue[] =
    event.kind === "notification" || event.kind === "notifications_merged"
      ? [{ kind: "User" }, { kind: "UserNotification" }]
      : [{ kind: "User" }];
  return publishToHub(env, accountId, { channels, event });
};
