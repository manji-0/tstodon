import {
  NotificationPolicy,
  type NotificationPolicyAction,
  type NotificationSender,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountStanding } from "./account-moderation-store";
import { findAccountById } from "./account-store";
import type { RepositoryError } from "./d1";
import { findFollowKind } from "./follow-store";
import { findNotificationPolicy, isSenderAccepted } from "./notification-policy-store";
import { RemoteAccountId } from "./remote-account-id";
import { getRemoteActorModeration } from "./remote-actor-moderation-store";
import { findRemoteFollow } from "./remote-actor-store";
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
  const follow = await findRemoteFollow(db, recipientId, actorUri);
  if (follow.isErr()) {
    return err(follow.error);
  }
  const moderation = await getRemoteActorModeration(db, actorUri);
  if (moderation.isErr()) {
    return err(moderation.error);
  }
  return ok({
    kind: "Remote",
    standing: moderation.value.standing,
    followsRecipient: follow.value?.requestKind === "Fulfilled",
  });
};

/** What `NotificationPolicy.disposition` needs to know about a local sender. */
const localSender = async (
  db: D1Database,
  input: DispositionInput,
  createdAt: string,
): Promise<Result<NotificationSender, RepositoryError>> => {
  const standing = await findAccountStanding(db, input.senderId);
  if (standing.isErr()) {
    return err(standing.error);
  }
  const followed = await findFollowKind(db, input.recipientId, input.senderId);
  if (followed.isErr()) {
    return err(followed.error);
  }
  const follows = await findFollowKind(db, input.senderId, input.recipientId);
  if (follows.isErr()) {
    return err(follows.error);
  }
  let privateMention = false;
  if (input.kind === "mention" && input.statusId) {
    const status = await findStatusById(db, input.statusId);
    if (status.isErr()) {
      return err(status.error);
    }
    privateMention =
      status.value !== undefined &&
      status.value.kind === "LocalNote" &&
      status.value.visibility.kind === "Direct";
  }
  return ok({
    kind: "Local",
    createdAt,
    silenced: standing.value.kind === "Silenced",
    recipientFollowsSender: followed.value === "Accepted",
    senderFollowsRecipient: follows.value === "Accepted",
    privateMention,
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
  const accepted = await isSenderAccepted(db, input.recipientId, input.senderId);
  if (accepted.isErr()) {
    return err(accepted.error);
  }
  if (accepted.value) {
    return ok("accept");
  }
  const policy = await findNotificationPolicy(db, input.recipientId);
  if (policy.isErr()) {
    return err(policy.error);
  }
  const account = await findAccountById(db, input.senderId);
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
