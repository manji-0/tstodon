import type { Result } from "neverthrow";
import type { RepositoryError } from "./repository-error";

/** Whether `actorUri` already follows, or asked to follow, the local account. */
export type HasRemoteFollow = (
  targetAccountId: string,
  actorUri: string,
) => Promise<Result<boolean, RepositoryError>>;
