import type { InstanceIdentity } from "@tstodon/domain";
import { findAccountsByIds } from "./account-store";
import { mastodonAccountDocuments, mastodonRemoteAccount } from "./mastodon";
import { RemoteAccountId } from "./remote-account-id";
import { findRemoteActorsByUris } from "./remote-actor-store";

/**
 * Account documents keyed by account id, for ids that may be local accounts
 * or remote actors (`r_…`); each side loads in one query, and ids that no
 * longer resolve are left out.
 */
export const accountDocumentsByIds = async (
  env: Env,
  identity: InstanceIdentity,
  ids: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, Record<string, unknown>>> => {
  const documents = new Map<string, Record<string, unknown>>();
  const remote = new Map<string, string>();
  const local: string[] = [];
  for (const id of new Set(ids)) {
    const actorUri = RemoteAccountId.decode(id);
    if (actorUri.isOk()) {
      remote.set(actorUri.value, id);
    } else {
      local.push(id);
    }
  }
  const [locals, actors] = await Promise.all([
    findAccountsByIds(env.DB, local),
    findRemoteActorsByUris(env.DB, [...remote.keys()]),
  ]);
  if (locals.isOk()) {
    for (const [id, document] of await mastodonAccountDocuments(env, identity, [
      ...locals.value.values(),
    ])) {
      documents.set(id, document);
    }
  }
  if (actors.isOk()) {
    for (const [actorUri, id] of remote) {
      const actor = actors.value.get(actorUri);
      if (actor) {
        documents.set(id, mastodonRemoteAccount(identity, actor));
      }
    }
  }
  return documents;
};
