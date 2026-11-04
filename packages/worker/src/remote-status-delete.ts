import type { Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { enqueueHomeFanOut } from "./home-fan-out";
import { deleteRemoteNotifications } from "./notification-store";
import { enqueuePublicFanOut } from "./public-fan-out";
import { deleteRemoteStatusById, deleteRemoteStatusByObjectUri } from "./remote-status-store";

/** The cached remote status an actor's delete names: by the object URI it signed, or by our id. */
export type RemoteStatusMatch =
  | Readonly<{ kind: "ObjectUri"; objectUri: string }>
  | Readonly<{ kind: "Id"; id: string }>;

/**
 * Delete a cached remote status that `actorUri` wrote and tell everyone who
 * could hold it: followers' home streams, the public streams, and the mention
 * notifications it caused. Used for a remote `Delete` and for a moderator's
 * removal. `false` when the actor wrote no such status.
 */
export const removeRemoteStatus = async (
  env: Env,
  actorUri: string,
  match: RemoteStatusMatch,
): Promise<Result<boolean, RepositoryError>> => {
  const deleted =
    match.kind === "ObjectUri"
      ? await deleteRemoteStatusByObjectUri(env.DB, match.objectUri, actorUri)
      : await deleteRemoteStatusById(env.DB, match.id, actorUri);
  if (deleted.isOk() && deleted.value) {
    await enqueueHomeFanOut(env, {
      event: "delete",
      entryId: deleted.value.id,
      author: { kind: "RemoteActor", actorUri },
    });
    if (deleted.value.public) {
      await enqueuePublicFanOut(env, { event: "delete", entryId: deleted.value.id });
    }
    // Its mention notifications go with it.
    await deleteRemoteNotifications(env.DB, {
      actorUri,
      kinds: ["mention"],
      statusId: deleted.value.id,
    });
  }
  return deleted.map((row) => row !== undefined);
};
