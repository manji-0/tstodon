import type { InstanceIdentity } from "@tstodon/domain";
import { mastodonRemoteStatus, mastodonStatuses } from "./mastodon";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { findRemoteStatusesByIds } from "./remote-status-store";
import { findStatusesByIds } from "./status-store";

/**
 * Status documents keyed by status id, for ids that may be local statuses or
 * cached remote ones (the formats are shared, so both tables are asked). No
 * visibility check is made here: callers pass statuses the viewer may see,
 * such as a notification's status or a thread already filtered.
 */
export const statusDocumentsByIds = async (
  env: Env,
  identity: InstanceIdentity,
  ids: ReadonlyArray<string>,
  viewerId: string | undefined,
): Promise<ReadonlyMap<string, Record<string, unknown>>> => {
  const documents = new Map<string, Record<string, unknown>>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return documents;
  }
  const [locals, remotes] = await Promise.all([
    findStatusesByIds(env.DB, unique),
    findRemoteStatusesByIds(env.DB, unique),
  ]);
  if (locals.isOk()) {
    for (const document of await mastodonStatuses(
      env,
      identity,
      [...locals.value.values()],
      viewerId,
    )) {
      if (typeof document.id === "string") {
        documents.set(document.id, document);
      }
    }
  }
  if (remotes.isOk()) {
    const statuses = [...remotes.value.values()].filter((status) => !documents.has(status.id));
    const actors = await findRemoteActorsByUris(
      env.DB,
      statuses.map((status) => status.actorUri),
    );
    if (actors.isOk()) {
      for (const status of statuses) {
        const actor = actors.value.get(status.actorUri);
        if (actor) {
          documents.set(status.id, mastodonRemoteStatus(identity, status, actor));
        }
      }
    }
  }
  return documents;
};
