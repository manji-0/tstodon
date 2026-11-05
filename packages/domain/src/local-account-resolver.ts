import type { Result } from "neverthrow";
import type { LocalAccount } from "./registration";
import type { RepositoryError } from "./repository-error";

/** The local account with this username, when there is one. */
export type FindLocalAccountByUsername = (
  username: string,
) => Promise<Result<LocalAccount | undefined, RepositoryError>>;
