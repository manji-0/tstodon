import type { Result } from "neverthrow";
import type { RepositoryError } from "./repository-error";

/** Which of `statusIds` sit in a conversation `accountId` muted. */
export type FindMutedThreadStatusIds = (
  accountId: string,
  statusIds: ReadonlyArray<string>,
) => Promise<Result<ReadonlySet<string>, RepositoryError>>;
