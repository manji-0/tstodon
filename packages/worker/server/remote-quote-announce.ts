import type { RemoteStatusValue } from "@tstodon/domain";
import { enqueueHomeFanOut } from "./home-fan-out";
import { enqueuePublicFanOut } from "./public-fan-out";

/**
 * Tell local timelines that show a remote quoting note that its quote
 * changed, as Mastodon's `DistributionWorker` with `update`.
 */
export const announceRemoteQuoteChange = async (
  env: Env,
  status: RemoteStatusValue,
): Promise<void> => {
  await enqueueHomeFanOut(env, {
    event: "status.update",
    entryId: status.id,
    author: { kind: "RemoteActor", actorUri: status.actorUri },
  });
  if (status.visibility.kind === "Public") {
    await enqueuePublicFanOut(env, { event: "status.update", entryId: status.id });
  }
};
