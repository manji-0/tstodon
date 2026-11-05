import { StatusId, StatusTarget } from "@tstodon/domain";
import { ok } from "neverthrow";
import { parseLocalStatusId } from "../activitypub";
import { upsertRemoteFavourite } from "../remote-interaction-store";
import { favouriteStatus } from "../status-interaction-store";
import type { InboxHandler, LocalDelivery, RemoteDelivery } from "./handler";
import { notifyStatusAuthor } from "./notify-status-author";

export const receiveRemoteLike: InboxHandler<RemoteDelivery<"Like">> = async ({
  env,
  identity,
  signer,
  activity,
}) => {
  const statusId = parseLocalStatusId(identity, activity.object);
  if (!statusId) {
    return ok(undefined);
  }
  const liked = await upsertRemoteFavourite(env.DB, signer.actorUri, statusId);
  if (liked.isOk() && liked.value) {
    await notifyStatusAuthor(env, signer.actorUri, statusId, "favourite");
  }
  return ok(undefined);
};

export const receiveLocalLike: InboxHandler<LocalDelivery<"Like">> = async ({
  env,
  identity,
  signer,
  activity,
}) => {
  const statusId = StatusId.parse(parseLocalStatusId(identity, activity.object) ?? "");
  if (statusId.isOk()) {
    await favouriteStatus(env.DB, signer.id, StatusTarget.local(statusId.value));
  }
  return ok(undefined);
};
