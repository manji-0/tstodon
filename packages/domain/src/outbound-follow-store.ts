import type { Result } from "neverthrow";
import type { RepositoryError } from "./repository-error";

/**
 * The follow an `Accept` or `Reject` from `actorUri` answers: the one whose
 * `Follow` id it names, or, when the answer embeds a `Follow` from a local
 * account, that account's follow of the actor.
 */
export type OutboundFollowAnswer = Readonly<{
  actorUri: string;
  followActivityId: string;
  accountId: string | undefined;
}>;

/** Mark the answered follow `Accepted`. Resolves to true when a follow matched. */
export type AcceptOutboundFollow = (
  answer: OutboundFollowAnswer,
) => Promise<Result<boolean, RepositoryError>>;

/** Drop the answered follow. Resolves to true when a follow matched. */
export type RejectOutboundFollow = (
  answer: OutboundFollowAnswer,
) => Promise<Result<boolean, RepositoryError>>;
