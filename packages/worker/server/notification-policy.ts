import {
  NotificationPolicy,
  type NotificationPolicyAction,
  type NotificationSender,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountStanding } from "./account-moderation-store";
import { findAccountProfile } from "./account-profile-store";
import { findAccountById } from "./account-store";
import type { RepositoryError } from "./d1";
import { findFollowKind } from "./follow-store";
import { findNotificationPolicy, isSenderAccepted } from "./notification-policy-store";
import { RemoteAccountId } from "./remote-account-id";
import { getRemoteActorModeration } from "./remote-actor-moderation-store";
import { findRemoteActorByUri, findRemoteFollow } from "./remote-actor-store";
import { findStatusById } from "./status-store";

export type NotificationDisposition = NotificationPolicyAction;

type DispositionInput = Readonly<{
  recipientId: string;
  senderId: string;
  kind: string;
  statusId?: string | undefined;
}>;

/** What `NotificationPolicy.disposition` needs to know about a remote (`r_…`) sender. */
const remoteSender = async (
  db: D1Database,
  recipientId: string,
  actorUri: string,
): Promise<Result<NotificationSender, RepositoryError>> => {
  const [follow, moderation, actor] = await Promise.all([
    findRemoteFollow(db, recipientId, actorUri),
    getRemoteActorModeration(db, actorUri),
    findRemoteActorByUri(db, actorUri),
  ]);
  if (follow.isErr()) {
    return err(follow.error);
  }
  if (moderation.isErr()) {
    return err(moderation.error);
  }
  if (actor.isErr()) {
    return err(actor.error);
  }
  return ok({
    kind: "Remote",
    standing: moderation.value.standing,
    followsRecipient: follow.value?.requestKind === "Fulfilled",
    bot: actor.value?.profile.bot ?? false,
  });
};

const localSender = async (
  db: D1Database,
  input: DispositionInput,
  createdAt: string,
): Promise<Result<NotificationSender, RepositoryError>> => {
  // Independent reads: one D1 round instead of one each.
  const [standing, profile, followed, follows, status] = await Promise.all([
    findAccountStanding(db, input.senderId),
    findAccountProfile(db, input.senderId),
    findFollowKind(db, input.recipientId, input.senderId),
    findFollowKind(db, input.senderId, input.recipientId),
    input.kind === "mention" && input.statusId
      ? findStatusById(db, input.statusId)
      : Promise.resolve(ok(undefined)),
  ]);
  if (standing.isErr()) {
    return err(standing.error);
  }
  if (profile.isErr()) {
    return err(profile.error);
  }
  if (followed.isErr()) {
    return err(followed.error);
  }
  if (follows.isErr()) {
    return err(follows.error);
  }
  if (status.isErr()) {
    return err(status.error);
  }
  return ok({
    kind: "Local",
    createdAt,
    silenced: standing.value.kind === "Silenced",
    recipientFollowsSender: followed.value === "Accepted",
    senderFollowsRecipient: follows.value === "Accepted",
    privateMention:
      status.value !== undefined &&
      status.value.kind === "LocalNote" &&
      status.value.visibility.kind === "Direct",
    bot: profile.value.bot,
  });
};

/**
 * The recipient's notification policy applied to this notification. An
 * accepted sender always gets through, and a sender id that is neither a
 * local account nor a remote one is accepted.
 */
export const notificationDisposition = async (
  db: D1Database,
  input: DispositionInput,
): Promise<Result<NotificationDisposition, RepositoryError>> => {
  // The policy and the sender's account are read with the acceptance check,
  // not after it: an accepted sender is rare, a serial round is not.
  const [accepted, policy, account] = await Promise.all([
    isSenderAccepted(db, input.recipientId, input.senderId),
    findNotificationPolicy(db, input.recipientId),
    findAccountById(db, input.senderId),
  ]);
  if (accepted.isErr()) {
    return err(accepted.error);
  }
  if (accepted.value) {
    return ok("accept");
  }
  if (policy.isErr()) {
    return err(policy.error);
  }
  if (account.isErr()) {
    return err(account.error);
  }
  let sender: Result<NotificationSender, RepositoryError>;
  if (account.value) {
    sender = await localSender(db, input, account.value.createdAt);
  } else {
    const actorUri = RemoteAccountId.decode(input.senderId);
    if (actorUri.isErr()) {
      return ok("accept");
    }
    sender = await remoteSender(db, input.recipientId, actorUri.value);
  }
  return sender.map((facts) => NotificationPolicy.disposition(policy.value, facts, Date.now()));
};
