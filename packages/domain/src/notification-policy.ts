import { NotificationPolicyAction } from "./notification-policy-action";
import type { AccountStanding } from "./account-standing";

/** A recipient's handling of each of Mastodon's notification-policy categories. */
export type NotificationPolicy = Readonly<{
  forNotFollowing: NotificationPolicyAction;
  forNotFollowers: NotificationPolicyAction;
  forNewAccounts: NotificationPolicyAction;
  forPrivateMentions: NotificationPolicyAction;
  forLimitedAccounts: NotificationPolicyAction;
}>;

/** What the policy needs to know about a local sender. */
export type LocalNotificationSender = Readonly<{
  kind: "Local";
  createdAt: string;
  silenced: boolean;
  recipientFollowsSender: boolean;
  senderFollowsRecipient: boolean;
  /** The notification is a mention on a direct status. */
  privateMention: boolean;
}>;

/** What the policy needs to know about a remote sender. */
export type RemoteNotificationSender = Readonly<{
  kind: "Remote";
  standing: AccountStanding;
  followsRecipient: boolean;
}>;

export type NotificationSender = LocalNotificationSender | RemoteNotificationSender;

const NEW_ACCOUNT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Mastodon's defaults: private mentions are dropped, limited accounts filtered. */
const defaultPolicy: NotificationPolicy = {
  forNotFollowing: "accept",
  forNotFollowers: "accept",
  forNewAccounts: "accept",
  forPrivateMentions: "drop",
  forLimitedAccounts: "filter",
};

/**
 * Local accounts cannot follow remote ones here, so `for_not_following`
 * always applies to a remote sender. `for_private_mentions` is not applied:
 * its exemption is "the recipient follows the sender", which a remote sender
 * can never meet, so the `drop` default would discard every remote direct
 * message. `for_new_accounts` needs local account state.
 */
const remoteActions = (
  policy: NotificationPolicy,
  sender: RemoteNotificationSender,
): NotificationPolicyAction[] => [
  policy.forNotFollowing,
  ...(sender.standing.kind === "Silenced" ? [policy.forLimitedAccounts] : []),
  ...(sender.standing.kind === "Suspended" ? (["drop"] as const) : []),
  ...(sender.followsRecipient ? [] : [policy.forNotFollowers]),
];

/** A private mention from an account the recipient follows is exempt (Mastodon's exception). */
const localActions = (
  policy: NotificationPolicy,
  sender: LocalNotificationSender,
  now: number,
): NotificationPolicyAction[] => {
  const created = Date.parse(sender.createdAt);
  const fresh = Number.isFinite(created) && now - created < NEW_ACCOUNT_WINDOW_MS;
  return [
    ...(sender.privateMention && !sender.recipientFollowsSender ? [policy.forPrivateMentions] : []),
    ...(sender.silenced ? [policy.forLimitedAccounts] : []),
    ...(fresh ? [policy.forNewAccounts] : []),
    ...(sender.recipientFollowsSender ? [] : [policy.forNotFollowing]),
    ...(sender.senderFollowsRecipient ? [] : [policy.forNotFollowers]),
  ];
};

export const NotificationPolicy = {
  default: defaultPolicy,
  /**
   * Which categories apply to a notification from this sender, resolved to
   * the most restrictive action. `now` is in epoch milliseconds.
   */
  disposition: (
    policy: NotificationPolicy,
    sender: NotificationSender,
    now: number,
  ): NotificationPolicyAction =>
    NotificationPolicyAction.mostRestrictive(
      sender.kind === "Remote" ? remoteActions(policy, sender) : localActions(policy, sender, now),
    ),
} as const;
