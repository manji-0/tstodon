import { assertNever } from "@tstodon/core";
import { Hostname, type InstanceIdentity } from "@tstodon/domain";
import { err, ok } from "neverthrow";
import { parseLocalStatusId } from "../activitypub";
import { purgeRemoteActorAndAnnounce } from "../remote-actor-purge";
import { RemoteDeleteTarget } from "../remote-delete";
import { removeRemoteStatus } from "../remote-status-delete";
import { findRemoteStatusByObjectUri, recordRemoteTombstone } from "../remote-status-store";
import { answersGone } from "../federated-fetch";
import { forwardRemoteActivity } from "../activity-forward";
import type { ActivityOf, InboxHandler, RemoteDelivery } from "./handler";
import { revokeRemoteFeatureAuthorization } from "./feature-answer";
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
  route,
  allowHosts,
  blockedHosts,
  fetchSigner,
}) => {
  const effect = remoteDeleteEffect(identity, activity);
  // `Delete#perform`: an authorization the signer gave a local collection.
  if (effect.kind !== "PurgeActor") {
    const revoked = await revokeRemoteFeatureAuthorization(env, signer, activity.object);
    if (revoked.isErr()) {
      return err(revoked.error);
    }
    if (revoked.value) {
      return ok(undefined);
    }
  }
  switch (effect.kind) {
    case "PurgeActor": {
      // A forwarded account `Delete` is not taken on the forwarder's word:
      // the account goes only when its own server answers 404 or 410 for it.
      if (
        route.kind === "Forwarded" &&
        !(await answersGone(identity, effect.actorUri, { allowHosts, blockedHosts, fetchSigner }))
      ) {
        return ok(undefined);
      }
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
      // Mastodon's `Tombstone`: a `Create` of the URI, replayed or late, is
      // not stored again. Only for a URI on the actor's own host.
      if (Hostname.ofUri(effect.objectUri) === Hostname.ofUri(signer.actorUri)) {
        const buried = await recordRemoteTombstone(env.DB, effect.objectUri, signer.actorUri);
        if (buried.isErr()) {
          return err(buried.error);
        }
      }
      // As Mastodon's `Delete#delete_status`, forwarded before the status,
      // and the boosts and quotes that decide who hears it, are gone.
      const status = await findRemoteStatusByObjectUri(env.DB, effect.objectUri);
      if (status.isErr()) {
        return err(status.error);
      }
      if (status.value?.actorUri === signer.actorUri) {
        await forwardRemoteActivity(env, identity, status.value, signer, { kind: "Delete", body });
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
