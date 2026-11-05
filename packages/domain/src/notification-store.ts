import type { Result } from "neverthrow";
import type { RepositoryError } from "./repository-error";

/** A notification to record for `accountId`, before it has an id. */
export type NewNotification = Readonly<{
  accountId: string;
  fromAccountId: string;
  /** The sender's actor URI when it is a remote account. */
  fromActorUri?: string;
  kind: string;
  statusId?: string;
  /** The account a `move` notification points at: where the sender moved to. */
  targetAccountId?: string;
  /** The report an `admin.report` notification points at. */
  reportId?: string;
  /** The account's severance event a `severed_relationships` notification reports. */
  severanceEventId?: string;
}>;

/**
 * What the sender's standing with the recipient decides before the
 * recipient's policy, as Mastodon's `NotifyService::DropCondition`. `Drop`
 * records nothing. `Bypass`, a mention from staff who outrank the recipient,
 * skips the policy and muted conversations. `Screen` leaves it to them.
 */
export type SenderScreening =
  | Readonly<{ kind: "Drop" }>
  | Readonly<{ kind: "Bypass" }>
  | Readonly<{ kind: "Screen" }>;

/**
 * Screen the notification's sender: the recipient itself, staff, a sender
 * the recipient blocks or mutes notifications of, or a remote sender the
 * recipient does not follow on a domain it blocks.
 */
export type ScreenSender = (
  notification: NewNotification,
) => Promise<Result<SenderScreening, RepositoryError>>;

/** Record the notification; resolves to its new id. */
export type InsertNotification = (
  notification: NewNotification,
) => Promise<Result<string, RepositoryError>>;

/** File a recorded notification under the recipient's notification requests. */
export type HoldNotification = (
  notificationId: string,
  notification: NewNotification,
) => Promise<Result<void, RepositoryError>>;

/**
 * What a remote actor's undone activity or deleted note had notified: its
 * notifications of `kinds` about one status.
 */
export type RemoteNotificationWithdrawal = Readonly<{
  actorUri: string;
  kinds: ReadonlyArray<string>;
  statusId: string;
}>;

/** Delete the withdrawn notifications; resolves to how many went. */
export type WithdrawRemoteNotifications = (
  withdrawal: RemoteNotificationWithdrawal,
) => Promise<Result<number, RepositoryError>>;

/** Tell the recipient's streams and push subscriptions about a delivered notification. */
export type PublishNotification = (accountId: string, notificationId: string) => Promise<void>;
