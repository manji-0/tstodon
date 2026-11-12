import type {
  DeleteRemoteStatus,
  PublishRemoteStatusRemoval,
  RemoteStatusMatch,
  WithdrawRemoteNotifications,
} from "@tstodon/domain";
import type { Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { announceRemovedBoosts, startHomeFanOut } from "./home-fan-out";
import { deleteRemoteNotifications } from "./notification-store";
import { startPublicFanOut } from "./public-fan-out";
import { deleteRemoteStatusById, deleteRemoteStatusByObjectUri } from "./remote-status-store";

/** What removing a cached remote status writes and announces. */
export type RemoteStatusRemovalContracts = Readonly<{
  deleteRemoteStatus: DeleteRemoteStatus;
  publishRemoval: PublishRemoteStatusRemoval;
  withdrawRemoteNotifications: WithdrawRemoteNotifications;
}>;

/**
 * Delete a cached remote status that `actorUri` wrote and tell everyone who
 * could hold it, and withdraw the mention notifications it caused. `false`
 * when the actor wrote no such status.
 */
export const withdrawRemoteStatus = async (
  contracts: RemoteStatusRemovalContracts,
  actorUri: string,
  match: RemoteStatusMatch,
): Promise<Result<boolean, RepositoryError>> => {
  const deleted = await contracts.deleteRemoteStatus(actorUri, match);
  if (deleted.isOk() && deleted.value) {
    await contracts.publishRemoval(actorUri, deleted.value);
    await contracts.withdrawRemoteNotifications({
      actorUri,
      kinds: ["mention"],
      statusId: deleted.value.id,
    });
  }
  return deleted.map((removed) => removed !== undefined);
};

const remoteStatusRemovalContracts = (env: Env): RemoteStatusRemovalContracts => ({
  deleteRemoteStatus: (actorUri, match) =>
    match.kind === "ObjectUri"
      ? deleteRemoteStatusByObjectUri(env.DB, match.objectUri, actorUri)
      : deleteRemoteStatusById(env.DB, match.id, actorUri),
  publishRemoval: async (actorUri, removed) => {
    await announceRemovedBoosts(env, removed.boosts);
    startHomeFanOut(env, {
      event: "delete",
      entryId: removed.id,
      author: { kind: "RemoteActor", actorUri },
    });
    if (removed.public) {
      startPublicFanOut(env, { event: "delete", entryId: removed.id });
    }
  },
  withdrawRemoteNotifications: (withdrawal) => deleteRemoteNotifications(env.DB, withdrawal),
});

/** Remove a remote status for a remote `Delete` or a moderator's removal. */
export const removeRemoteStatus = (
  env: Env,
  actorUri: string,
  match: RemoteStatusMatch,
): Promise<Result<boolean, RepositoryError>> =>
  withdrawRemoteStatus(remoteStatusRemovalContracts(env), actorUri, match);
