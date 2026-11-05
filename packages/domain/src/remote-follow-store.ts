import type { Result } from "neverthrow";
import type { RepositoryError } from "./repository-error";

/** A remote actor's `Follow` of a local account, as its inbox delivery names it. */
export type InboxFollow = Readonly<{
  actorUri: string;
  targetAccountId: string;
  targetLocked: boolean;
  followActivityId: string | null;
}>;

/** Record the follow: queued for a locked account, fulfilled otherwise. */
export type RecordInboxFollow = (follow: InboxFollow) => Promise<Result<void, RepositoryError>>;
