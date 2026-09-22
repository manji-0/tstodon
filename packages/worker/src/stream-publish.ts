import type { StreamEvent as StreamEventValue } from "@tstodon/domain";

export const publishToAccount = async (
  env: Env,
  accountId: string,
  event: StreamEventValue,
): Promise<void> => {
  const stub = env.STREAM_HUB.get(env.STREAM_HUB.idFromName(accountId));
  await stub.publish(event);
};
