import type { Result } from "neverthrow";
import type { RemoteStatus } from "./remote-status";
import type { RepositoryError } from "./repository-error";
import type { LocalStatus } from "./status-composition";

/** A status in a thread: a local one, or a cached remote one. */
export type ThreadStatus =
  | Readonly<{ kind: "Local"; status: LocalStatus }>
  | Readonly<{ kind: "Remote"; status: RemoteStatus }>;

/** The status `status` replies to, when this server has it. */
export type FindThreadParent = (
  status: ThreadStatus,
) => Promise<Result<ThreadStatus | undefined, RepositoryError>>;
