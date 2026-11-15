import { NotificationPolicyAction } from "./notification-policy-action";
import type { AccountStanding } from "./account-standing";

/** A recipient's handling of each of Mastodon's notification-policy categories. */
export type NotificationPolicy = Readonly<{
  forNotFollowing: NotificationPolicyAction;
  forNotFollowers: NotificationPolicyAction;
  forNewAccounts: NotificationPolicyAction;
  forPrivateMentions: NotificationPolicyAction;
  forLimitedAccounts: NotificationPolicyAction;
  /** Mastodon 4.6: notifications from automated accounts. */
  forBots: NotificationPolicyAction;
}>;

/**
 * What the policy needs to know about the sender of a notification, a local
 * account or a remote one: the facts Mastodon's `NotifyService::BaseCondition`
 * reads.
 */
export type NotificationSender = Readonly<{
  /**
   * When the account was created, as Mastodon's `accounts.created_at` holds
   * it: a local account's sign-up, and a remote actor's `published` date, or
   * when this server first stored the actor if its document gives none.
   */
  createdAt: string;
  standing: AccountStanding;
  /** A local profile marked as a bot, or a remote `Service` or `Application` actor. */
  bot: boolean;
  /** The recipient follows the sender, with an accepted follow. */
  followedByRecipient: boolean;
  /** When the sender's accepted follow of the recipient began; absent when it does not follow. */
  followsRecipientSince: string | undefined;
  /**
   * The notification is a mention on a direct status that does not answer
   * the recipient ({@link NotificationPolicy.answersRecipient}).
   */
  unansweredPrivateMention: boolean;
}>;

/**
 * A status above a direct mention in its thread, as Mastodon's
 * `statuses_that_mention_sender` reads it.
 */
export type MentionAncestor = Readonly<{
  /** The recipient of the notification wrote it. */
  byRecipient: boolean;
  direct: boolean;
  /** It mentions the sender of the notification, not silently. */
  mentionsSender: boolean;
}>;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Mastodon's `NEW_ACCOUNT_THRESHOLD`. */
const NEW_ACCOUNT_WINDOW_MS = 30 * DAY_MS;
/** Mastodon's `NEW_FOLLOWER_THRESHOLD`: a follow this recent does not make a follower yet. */
const NEW_FOLLOWER_WINDOW_MS = 3 * DAY_MS;
/** Mastodon's `depth_limit` of 100 steps above the mention's parent. */
const ANCESTOR_LIMIT = 101;

/** Mastodon's defaults (`notification_policies` in `db/schema.rb`). */
const defaultPolicy: NotificationPolicy = {
  forNotFollowing: "accept",
  forNotFollowers: "accept",
  forNewAccounts: "accept",
  forPrivateMentions: "filter",
  forLimitedAccounts: "filter",
  forBots: "accept",
};

/** Whether `at` is within `windowMs` before `now`; a date that does not parse is not. */
const within = (at: string, windowMs: number, now: number): boolean => {
  const instant = Date.parse(at);
  return Number.isFinite(instant) && now - instant < windowMs;
};

/**
 * The categories that apply to the sender. Every category but
 * `for_not_followers` spares a sender the recipient follows. A suspended
 * sender is dropped whatever the policy.
 */
const actions = (
  policy: NotificationPolicy,
  sender: NotificationSender,
  now: number,
): NotificationPolicyAction[] => {
  const notFollower =
    sender.followsRecipientSince === undefined ||
    within(sender.followsRecipientSince, NEW_FOLLOWER_WINDOW_MS, now);
  const stranger: NotificationPolicyAction[] = sender.followedByRecipient
    ? []
    : [
        policy.forNotFollowing,
        ...(sender.standing.kind === "Silenced" ? [policy.forLimitedAccounts] : []),
        ...(within(sender.createdAt, NEW_ACCOUNT_WINDOW_MS, now) ? [policy.forNewAccounts] : []),
        ...(sender.unansweredPrivateMention ? [policy.forPrivateMentions] : []),
        ...(sender.bot ? [policy.forBots] : []),
      ];
  return [
    ...(sender.standing.kind === "Suspended" ? (["drop"] as const) : []),
    ...(notFollower ? [policy.forNotFollowers] : []),
    ...stranger,
  ];
};

export const NotificationPolicy = {
  default: defaultPolicy,
  /** How many statuses above a mention {@link NotificationPolicy.answersRecipient} reads. */
  ancestorLimit: ANCESTOR_LIMIT,
  /**
   * Which categories apply to a notification from this sender, resolved to
   * the most restrictive action. `now` is in epoch milliseconds.
   */
  disposition: (
    policy: NotificationPolicy,
    sender: NotificationSender,
    now: number,
  ): NotificationPolicyAction =>
    NotificationPolicyAction.mostRestrictive(actions(policy, sender, now)),
  /**
   * Whether {@link NotificationSender.unansweredPrivateMention} can change
   * the disposition: `for_private_mentions` spares a sender the recipient
   * follows, and an `accept` changes nothing. Mastodon walks the thread only
   * then.
   */
  readsPrivateMention: (policy: NotificationPolicy, followedByRecipient: boolean): boolean =>
    !followedByRecipient && policy.forPrivateMentions !== "accept",
  /**
   * Whether a direct mention answers the recipient: Mastodon's
   * `response_to_recipient?`. `ancestors` are the statuses above the mention,
   * nearest first. The walk up the thread ends at the mention's parent when
   * that mentions the sender, whoever wrote it, and else at the first status
   * of the recipient's that mentions the sender. The mention is an answer
   * when the status the walk ends at is a direct one the recipient wrote.
   */
  answersRecipient: (ancestors: ReadonlyArray<MentionAncestor>): boolean => {
    const found = ancestors
      .slice(0, ANCESTOR_LIMIT)
      .find((ancestor, index) => ancestor.mentionsSender && (index === 0 || ancestor.byRecipient));
    return found !== undefined && found.byRecipient && found.direct;
  },
} as const;
