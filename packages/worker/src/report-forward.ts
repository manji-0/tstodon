import { InstanceIdentity, type RemoteActor } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { enqueueInstanceActorActivity, type EnqueueLocalActivityError } from "./delivery";

/**
 * Forward a local report on a remote account to that account's server, as
 * Mastodon's `ReportService` does: a `Flag` from the instance actor, so the
 * other server learns what was reported but not who reported it, naming the
 * account and the reported posts.
 */
export const forwardReport = (
  env: Env,
  identity: InstanceIdentity,
  report: Readonly<{
    id: string;
    target: RemoteActor;
    comment: string;
    statusUris: ReadonlyArray<string>;
  }>,
): Promise<Result<void, EnqueueLocalActivityError>> => {
  const actor = InstanceIdentity.instanceActorUrl(identity);
  return enqueueInstanceActorActivity(
    env,
    "Flag",
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actor}/flags/${report.id}`,
      type: "Flag",
      actor,
      content: report.comment,
      object: [report.target.actorUri, ...report.statusUris],
    },
    report.target.inboxUri,
  );
};
