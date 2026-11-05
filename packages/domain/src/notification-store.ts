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
 * Does the recipient block the notification's sender or mute its
 * notifications, or block the domain of a remote sender?
 */
export type IsSenderSilenced = (
  notification: NewNotification,
) => Promise<Result<boolean, RepositoryError>>;

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
 * notifications of `kinds`, narrowed to one recipient and/or status when given.
 */
export type RemoteNotificationWithdrawal = Readonly<{
  actorUri: string;
  kinds: ReadonlyArray<string>;
  accountId?: string;
  statusId?: string;
}>;

/** Delete the withdrawn notifications; resolves to how many went. */
export type WithdrawRemoteNotifications = (
  withdrawal: RemoteNotificationWithdrawal,
) => Promise<Result<number, RepositoryError>>;

/** Tell the recipient's streams and push subscriptions about a delivered notification. */
export type PublishNotification = (accountId: string, notificationId: string) => Promise<void>;
