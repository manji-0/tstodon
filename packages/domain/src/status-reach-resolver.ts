import type { Result } from "neverthrow";
import type { RepositoryError } from "./repository-error";
import type { ThreadStatus } from "./thread-status";

/**
 * The delivery inboxes (a shared inbox standing for its actors) of the
 * remote actors a status reached by interaction, as Mastodon's
 * `StatusReachFinder#reached_account_ids` with `unsafe: true`: the actors it
 * mentions, those that boosted or favourited it, and the authors of replies.
 */
export type ListStatusInteractorInboxes = (
  status: ThreadStatus,
) => Promise<Result<ReadonlyArray<string>, RepositoryError>>;

/** The delivery inboxes of a local account's accepted remote followers. */
export type ListRemoteFollowerInboxes = (
  accountId: string,
) => Promise<Result<ReadonlyArray<string>, RepositoryError>>;

/** The delivery inbox of a cached remote actor, `undefined` when it is not cached. */
export type FindRemoteActorInbox = (
  actorUri: string,
) => Promise<Result<string | undefined, RepositoryError>>;

/** The local accounts that boosted a status, in boost order. */
export type ListLocalBoosterAccountIds = (
  status: ThreadStatus,
) => Promise<Result<ReadonlyArray<string>, RepositoryError>>;
