import {
  LocalStatus,
  RealtimeWindow,
  StatusId,
  StatusTarget,
  Visibility,
  reblogVisibility,
} from "@tstodon/domain";
import { err, ok } from "neverthrow";
import { parseLocalStatusId } from "../activitypub";
import { nowInstant } from "../clock";
import { startHomeFanOut } from "../home-fan-out";
import { newEntityId } from "../ids";
import { recordRemoteBoost } from "../remote-boost";
import { upsertRemoteAnnounce } from "../remote-interaction-store";
import { persistAnnouncedObject } from "../remote-status-persist";
import { findStatusById, insertLocalReblog } from "../status-store";
import type { InboxHandler, LocalDelivery, RemoteDelivery } from "./handler";
import { notifyStatusAuthor } from "./notify-status-author";

export const receiveRemoteAnnounce: InboxHandler<RemoteDelivery<"Announce">> = async ({
  env,
  identity,
  signer,
  activity,
  received,
  allowHosts,
  blockedHosts,
  fetchSigner,
}) => {
  // As Mastodon's `announceable?`, a remote actor may share a local status
  // only when it is public or unlisted; otherwise the Announce is dropped.
  const statusId = parseLocalStatusId(identity, activity.object);
  const target = statusId ? await findStatusById(env.DB, statusId) : ok(undefined);
  if (target.isErr()) {
    return err(target.error);
  }
  if (statusId && (!target.value || Visibility.isRestricted(target.value.visibility))) {
    return ok(undefined);
  }
  const announced = await persistAnnouncedObject(env, identity, signer, received.object, {
    allowHosts,
    blockedHosts,
    fetchSigner,
  });
  if (announced.isErr()) {
    return err(announced.error);
  }
  const boosted = await recordRemoteBoost(
    env.DB,
    identity,
    signer.actorUri,
    activity,
    received,
    announced.value,
  );
  if (boosted.isErr()) {
    return err(boosted.error);
  }
  // As for a `Create`, a boost published more than the real-time window ago
  // is stored but not streamed.
  if (boosted.value && RealtimeWindow.contains(boosted.value.publishedAt, nowInstant())) {
    await startHomeFanOut(env, {
      event: "update",
      entryId: boosted.value.id,
      author: { kind: "RemoteActor", actorUri: signer.actorUri },
    });
  }
  if (statusId) {
    const counted = await upsertRemoteAnnounce(env.DB, signer.actorUri, statusId, activity.id);
    if (counted.isOk() && counted.value) {
      await notifyStatusAuthor(env, signer.actorUri, statusId, "reblog", target.value);
    }
  }
  return ok(undefined);
};

export const receiveLocalAnnounce: InboxHandler<LocalDelivery<"Announce">> = async ({
  env,
  identity,
  signer,
  activity,
}) => {
  const statusId = StatusId.parse(parseLocalStatusId(identity, activity.object) ?? "");
  if (statusId.isErr()) {
    return ok(undefined);
  }
  // The boost shares the original's visibility when that one is restricted.
  const target = await findStatusById(env.DB, statusId.value);
  const reblogId = StatusId.parse(newEntityId());
  if (reblogId.isOk() && target.isOk() && target.value) {
    await insertLocalReblog(
      env.DB,
      LocalStatus.reblog(
        reblogId.value,
        signer.id,
        StatusTarget.local(statusId.value),
        nowInstant(),
        reblogVisibility(target.value.visibility, undefined, Visibility.Public),
      ),
    );
  }
  return ok(undefined);
};
