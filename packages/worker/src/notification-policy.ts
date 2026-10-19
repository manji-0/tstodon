import type { Result } from "neverthrow";
import { getAccountModeration } from "./account-moderation-store";
import { findAccountById } from "./account-store";
import { err, ok } from "neverthrow";
import type { RepositoryError } from "./d1";
import {
  findNotificationPolicy,
  isSenderAccepted,
  type NotificationPolicyAction,
} from "./notification-policy-store";
import { findFollowKind } from "./social-store";
import { findStatusById } from "./status-store";

export type NotificationDisposition = NotificationPolicyAction;

const NEW_ACCOUNT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const mostRestrictive = (
  actions: ReadonlyArray<NotificationPolicyAction>,
): NotificationDisposition => {
  if (actions.includes("drop")) {
    return "drop";
  }
  if (actions.includes("filter")) {
    return "filter";
  }
  return "accept";
};

/**
 * Which of Mastodon's notification-policy categories apply to this
 * notification, resolved to the most restrictive action. An accepted sender
 * always gets through, and a private mention from an account the recipient
 * follows is exempt (Mastodon's documented exception).
 */
export const notificationDisposition = async (
  db: D1Database,
  input: Readonly<{
    recipientId: string;
    senderId: string;
    kind: string;
    statusId?: string | undefined;
  }>,
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
  const sender = await findAccountById(db, input.senderId);
  if (sender.isErr()) {
    return err(sender.error);
  }
  if (!sender.value) {
    return ok("accept");
  }

  const moderation = await getAccountModeration(db, input.senderId);
  if (moderation.isErr()) {
    return err(moderation.error);
  }

  const followed = await findFollowKind(db, input.recipientId, input.senderId);
  if (followed.isErr()) {
    return err(followed.error);
  }
  const follows = await findFollowKind(db, input.senderId, input.recipientId);
  if (follows.isErr()) {
    return err(follows.error);
  }
  const recipientFollowsSender = followed.value === "Accepted";

  let isPrivateMention = false;
  if (input.kind === "mention" && input.statusId) {
    const status = await findStatusById(db, input.statusId);
    if (status.isErr()) {
      return err(status.error);
    }
    isPrivateMention =
      status.value !== undefined &&
      status.value.kind === "LocalNote" &&
      status.value.visibility.kind === "Direct";
  }

  const created = Date.parse(sender.value.createdAt);
  const fresh = Number.isFinite(created) && Date.now() - created < NEW_ACCOUNT_WINDOW_MS;

  const actions: NotificationPolicyAction[] = [];
  if (isPrivateMention && !recipientFollowsSender) {
    actions.push(policy.value.forPrivateMentions);
  }
  if (moderation.value === "Silenced") {
    actions.push(policy.value.forLimitedAccounts);
  }
  if (fresh) {
    actions.push(policy.value.forNewAccounts);
  }
  if (!recipientFollowsSender) {
    actions.push(policy.value.forNotFollowing);
  }
  if (follows.value !== "Accepted") {
    actions.push(policy.value.forNotFollowers);
  }
  return ok(mostRestrictive(actions));
};
