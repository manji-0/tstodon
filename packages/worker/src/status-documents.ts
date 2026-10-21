import type { InstanceIdentity } from "@tstodon/domain";
import { parseLocalStatusId } from "./activitypub";
import { mastodonRemoteStatus } from "./remote-status-document";
import { mastodonStatuses } from "./local-status-documents";
import { RemoteAccountId } from "./remote-account-id";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { findRemoteStatusesByIds, findRemoteStatusRefsByObjectUris } from "./remote-status-store";
import { findRemoteStatusReplyTargets } from "./remote-reply-store";
import { findStatusesByIds } from "./status-store";

/**
 * Fill `in_reply_to_id` and `in_reply_to_account_id` on remote status
 * documents from the `inReplyTo` stored with them: a local parent by its id
 * and author, a cached remote one by its id and `r_…` author. A parent that
 * is not stored here stays null, as Mastodon renders an unfetched parent.
 * Other documents in the list are left alone.
 */
export const attachRemoteReplyRefs = async (
  db: D1Database,
  identity: InstanceIdentity,
  documents: ReadonlyArray<Record<string, unknown>>,
): Promise<void> => {
  const ids = documents.flatMap((document) =>
    typeof document.id === "string" && document.in_reply_to_id == null ? [document.id] : [],
  );
  const targets = await findRemoteStatusReplyTargets(db, ids);
  if (targets.isErr() || targets.value.size === 0) {
    return;
  }
  const localParents = new Map<string, string>();
  const remoteParents: string[] = [];
  for (const target of targets.value.values()) {
    const uri = target.inReplyToUri;
    if (!uri) {
      continue;
    }
    const localId = parseLocalStatusId(identity, uri);
    if (localId) {
      localParents.set(uri, localId);
    } else {
      remoteParents.push(uri);
    }
  }
  const [locals, remotes] = await Promise.all([
    findStatusesByIds(db, [...localParents.values()]),
    findRemoteStatusRefsByObjectUris(db, remoteParents),
  ]);
  for (const document of documents) {
    const target = typeof document.id === "string" ? targets.value.get(document.id) : undefined;
    const uri = target?.inReplyToUri;
    if (!uri) {
      continue;
    }
    const localId = localParents.get(uri);
    if (localId) {
      const parent = locals.isOk() ? locals.value.get(localId) : undefined;
      if (parent) {
        document.in_reply_to_id = parent.id;
        document.in_reply_to_account_id = parent.accountId;
      }
      continue;
    }
    const parent = remotes.isOk() ? remotes.value.get(uri) : undefined;
    if (parent) {
      document.in_reply_to_id = parent.id;
      document.in_reply_to_account_id = RemoteAccountId.encode(parent.actorUri);
    }
  }
};

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
  await attachRemoteReplyRefs(env.DB, identity, [...documents.values()]);
  return documents;
};
