import type { ApiOriginalStatusJSON, ApiStatusJSON } from "@tstodon/api";
import type { InstanceIdentity } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { mastodonStatuses } from "./local-status-documents";
import { mastodonRemoteStatuses } from "./remote-status-documents";
import { findRemoteStatusesByIds } from "./remote-status-store";
import { findStatusesByIds } from "./status-store";
import { documentsById } from "./documents-by-id";

/**
 * The original a rendered status shows: a boost's boosted status, else the
 * status itself. What a boost wraps as `reblog`, as Mastodon never boosts a
 * boost.
 */
export const originalStatus = (document: ApiStatusJSON): ApiOriginalStatusJSON =>
  document.reblog ?? { ...document, reblog: null };

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
): Promise<Result<ReadonlyMap<string, ApiStatusJSON>, RepositoryError>> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return ok(new Map());
  }
  const [locals, remotes] = await Promise.all([
    findStatusesByIds(env.DB, unique),
    findRemoteStatusesByIds(env.DB, unique),
  ]);
  if (locals.isErr()) {
    return err(locals.error);
  }
  if (remotes.isErr()) {
    return err(remotes.error);
  }
  const [localDocuments, remoteDocuments] = await Promise.all([
    mastodonStatuses(env, identity, [...locals.value.values()], viewerId),
    mastodonRemoteStatuses(
      env,
      identity,
      [...remotes.value.values()].filter((status) => !locals.value.has(status.id)),
      viewerId,
    ),
  ]);
  if (localDocuments.isErr()) {
    return err(localDocuments.error);
  }
  if (remoteDocuments.isErr()) {
    return err(remoteDocuments.error);
  }
  return ok(documentsById([...localDocuments.value, ...remoteDocuments.value]));
};
