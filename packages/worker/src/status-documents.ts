import type { InstanceIdentity } from "@tstodon/domain";
import { mastodonStatuses } from "./local-status-documents";
import { mastodonRemoteStatuses } from "./remote-status-documents";
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
  const rendered = [
    ...(locals.isOk()
      ? await mastodonStatuses(env, identity, [...locals.value.values()], viewerId)
      : []),
    ...(remotes.isOk()
      ? await mastodonRemoteStatuses(
          env,
          identity,
          [...remotes.value.values()].filter(
            (status) => !(locals.isOk() && locals.value.has(status.id)),
          ),
          viewerId,
        )
      : []),
  ];
  for (const document of rendered) {
    if (typeof document.id === "string") {
      documents.set(document.id, document);
    }
  }
  return documents;
};
