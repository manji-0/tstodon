import type { Result } from "neverthrow";
import type { RepositoryError } from "./repository-error";
import type { PreviousGroupBucket } from "./notification-group";

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
  /** The local collection a `collection_update` notification is about. */
  collectionId?: string;
  /** The remote collection a `collection_update` notification is about. */
  remoteCollectionId?: string;
  /** The collection item an `added_to_collection` notification is about. */
  collectionItemId?: string;
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
 * What Mastodon's `FeedManager#filter_from_mentions?` reads of the post a
 * mention notification is about: the accounts it mentions and the author of
 * the post it replies to, local accounts by id and remote ones by actor URI,
 * as blocks and mutes name them. Loaded once per post, however many accounts
 * it notifies.
 */
export type MentionedPost = Readonly<{ involvedAccounts: ReadonlyArray<string> }>;

/**
 * Screen the notification: a recipient that is unavailable (suspended), the
 * recipient itself, staff, a sender the recipient blocks or mutes
 * notifications of, a remote sender the recipient does not follow on a
 * domain it blocks, and for a `mention`, an account of `mentionedPost` the
 * recipient blocks or mutes notifications of.
 */
export type ScreenSender = (
  notification: NewNotification,
  mentionedPost?: MentionedPost,
) => Promise<Result<SenderScreening, RepositoryError>>;

/**
 * Record the notification under its group key, if it has one; resolves to
 * its new id, or `undefined` when it was already recorded and nothing was
 * inserted. The caller holds, publishes and pushes only a notification that
 * was inserted.
 */
export type InsertNotification = (
  notification: NewNotification,
  groupKey: string | undefined,
) => Promise<Result<string | undefined, RepositoryError>>;

/**
 * The bucket the account's last notification of a group type prefix went to,
 * as Mastodon's `notif-group/{account}/{prefix}` Redis key holds it; none
 * before the first.
 */
export type FindNotificationGroupBucket = (
  accountId: string,
  typePrefix: string,
) => Promise<Result<PreviousGroupBucket | undefined, RepositoryError>>;

/** File a recorded notification under the recipient's notification requests. */
export type HoldNotification = (
  notificationId: string,
  notification: NewNotification,
) => Promise<Result<void, RepositoryError>>;

/**
 * Keep the direct status a dropped mention names out of the recipient's
 * conversations for good, as Mastodon's `NotifyService` returns on `drop?`
 * before `push_to_conversation!`.
 */
export type KeepOutOfConversations = (
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
