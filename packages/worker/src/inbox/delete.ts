import { assertNever } from "@tstodon/core";
import type { InstanceIdentity } from "@tstodon/domain";
import { err, ok } from "neverthrow";
import { parseLocalStatusId } from "../activitypub";
import { purgeRemoteActorAndAnnounce } from "../remote-actor-purge";
import { RemoteDeleteTarget } from "../remote-delete";
import { removeRemoteStatus } from "../remote-status-delete";
import type { ActivityOf, InboxHandler, RemoteDelivery } from "./handler";
import { revokeQuoteStamp } from "./quote-answer";

/** What a remote actor's `Delete` removes on this server. */
type RemoteDeleteEffect =
  | Readonly<{ kind: "PurgeActor"; actorUri: string }>
  | Readonly<{ kind: "RemoveRemoteStatus"; objectUri: string }>
  /** A local status: only its local author deletes it. */
  | Readonly<{ kind: "Ignore" }>;

const remoteDeleteEffect = (
  identity: InstanceIdentity,
  activity: ActivityOf<"Delete">,
): RemoteDeleteEffect => {
  const target = RemoteDeleteTarget.of(activity.actor, activity.object);
  switch (target.kind) {
    case "ActorDelete":
      return { kind: "PurgeActor", actorUri: target.actorUri };
    case "ObjectDelete":
      return parseLocalStatusId(identity, target.objectUri)
        ? { kind: "Ignore" }
        : { kind: "RemoveRemoteStatus", objectUri: target.objectUri };
    default:
      return assertNever(target);
  }
};

export const receiveRemoteDelete: InboxHandler<RemoteDelivery<"Delete">> = async ({
  env,
  identity,
  signer,
  activity,
  body,
}) => {
  const effect = remoteDeleteEffect(identity, activity);
  switch (effect.kind) {
    case "PurgeActor": {
      const purged = await purgeRemoteActorAndAnnounce(env, effect.actorUri);
      return purged.isErr() ? err(purged.error) : ok(undefined);
    }
    case "RemoveRemoteStatus": {
      // A status URI never names a stamp, so a stamp found by it is what goes.
      const revoked = await revokeQuoteStamp(env, identity, signer, effect.objectUri, body);
      if (revoked.isErr()) {
        return err(revoked.error);
      }
      if (revoked.value) {
        return ok(undefined);
      }
      await removeRemoteStatus(env, signer.actorUri, {
        kind: "ObjectUri",
        objectUri: effect.objectUri,
      });
      return ok(undefined);
    }
    case "Ignore":
      return ok(undefined);
    default:
      return assertNever(effect);
  }
};
