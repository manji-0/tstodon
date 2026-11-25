import {
  type InstanceIdentity,
  RemoteActor,
  StatusTarget,
  type ThreadStatus,
} from "@tstodon/domain";
import { err, ok } from "neverthrow";
import { findAccountById } from "./account-store";
import { localNoteRef } from "./activitypub";
import { findRemoteActorByUri, listAcceptedRemoteFollowerInboxes } from "./remote-actor-store";
import { listStatusInteractorInboxes } from "./remote-interaction-store";
import {
  listLocalBoosterFollowerInboxes,
  listLocalSharerAccountIds,
} from "./status-interaction-store";
import type { RemoteActivityForwardOperations, StatusDeleteReachOperations } from "./status-reach";
import { findThreadParent } from "./thread-context";

/** The D1 lookups behind `statusReachInboxes` and `statusDeleteReach`. */
export const statusReachOperations = (
  env: Env,
  identity: InstanceIdentity,
): StatusDeleteReachOperations & RemoteActivityForwardOperations => ({
  listInteractorInboxes: async (status) => {
    if (status.kind === "Remote") {
      return listStatusInteractorInboxes(env.DB, {
        kind: "Remote",
        statusId: status.status.id,
        uri: status.status.objectUri,
      });
    }
    const author = await findAccountById(env.DB, status.status.accountId);
    if (author.isErr()) {
      return err(author.error);
    }
    if (!author.value) {
      return ok([]);
    }
    return listStatusInteractorInboxes(env.DB, {
      kind: "Local",
      statusId: status.status.id,
      uri: localNoteRef(identity, author.value, status.status.id).uri,
    });
  },
  listRemoteFollowerInboxes: (accountId) => listAcceptedRemoteFollowerInboxes(env.DB, accountId),
  findRemoteActorInbox: async (actorUri) =>
    (await findRemoteActorByUri(env.DB, actorUri)).map((actor) =>
      actor ? RemoteActor.deliveryInbox(actor) : undefined,
    ),
  findThreadParent: (status) => findThreadParent(env.DB, identity, status),
  listLocalBoosterFollowerInboxes: (status) =>
    listLocalBoosterFollowerInboxes(env.DB, statusTargetOf(status)),
  listLocalSharerAccountIds: (status, limit) =>
    listLocalSharerAccountIds(env.DB, statusTargetOf(status), limit),
});

/** The `StatusTarget` naming a local or a remote thread status. */
export const statusTargetOf = (status: ThreadStatus) =>
  status.kind === "Local"
    ? StatusTarget.local(status.status.id)
    : StatusTarget.remote(status.status.id);
