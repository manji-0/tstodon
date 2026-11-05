import type { Result } from "neverthrow";
import type { RepositoryError } from "./repository-error";

/** The cached remote status an actor's delete names: by the object URI it signed, or by our id. */
export type RemoteStatusMatch =
  | Readonly<{ kind: "ObjectUri"; objectUri: string }>
  | Readonly<{ kind: "Id"; id: string }>;

/** A local account's boost that went away with the status it boosted. */
export type RemovedBoost = Readonly<{ id: string; accountId: string }>;

/** A cached remote status that was deleted, with the local boosts that went with it. */
export type RemovedRemoteStatus = Readonly<{
  id: string;
  public: boolean;
  boosts: ReadonlyArray<RemovedBoost>;
}>;

/**
 * Delete the cached remote status `match` names, only when `actorUri` wrote
 * it. Resolves to `undefined` when the actor wrote no such status.
 */
export type DeleteRemoteStatus = (
  actorUri: string,
  match: RemoteStatusMatch,
) => Promise<Result<RemovedRemoteStatus | undefined, RepositoryError>>;

/** Tell the streams and timelines that could hold the deleted status that it is gone. */
export type PublishRemoteStatusRemoval = (
  actorUri: string,
  removed: RemovedRemoteStatus,
) => Promise<void>;
