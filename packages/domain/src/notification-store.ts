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

/** Record the notification; resolves to its new id. */
export type InsertNotification = (
  notification: NewNotification,
) => Promise<Result<string, RepositoryError>>;

/** File a recorded notification under the recipient's notification requests. */
export type HoldNotification = (
  notificationId: string,
  notification: NewNotification,
) => Promise<Result<void, RepositoryError>>;

/** Tell the recipient's streams and push subscriptions about a delivered notification. */
export type PublishNotification = (accountId: string, notificationId: string) => Promise<void>;
