import { InstanceIdentity, type RemoteActor } from "@tstodon/domain";
import { findAccountsByIds } from "./account-store";
import type { NoteMention } from "./activitypub";
import { listStatusMentions } from "./mention-store";
import { suspendedDomains } from "./admin-domain-block-store";
import { remoteMentionHandles } from "./html";
import { resolveRemoteActorByHandle } from "./remote-actor-fetch";
import { findRemoteActorByHandle, findRemoteActorsByUris } from "./remote-actor-store";
import { federationAllowHosts } from "./runtime-config";

/**
 * Remote actors a post's `@user@domain` handles name: the cached actor when
 * there is one, otherwise resolved over WebFinger. A handle on a suspended or
 * non-federating domain, or one that does not resolve, is left out and the
 * post goes ahead, as in Mastodon.
 */
export const resolveRemoteMentions = async (
  env: Env,
  identity: InstanceIdentity,
  text: string,
): Promise<ReadonlyArray<RemoteActor>> => {
  const handles = remoteMentionHandles(text, identity.domain);
  if (handles.length === 0) {
    return [];
  }
  const blockedHosts = await suspendedDomains(env.DB);
  const allowHosts = await federationAllowHosts(env);
  const actors = new Map<string, RemoteActor>();
  for (const handle of handles) {
    if (blockedHosts.has(handle.domain)) {
      continue;
    }
    const cached = await findRemoteActorByHandle(env.DB, handle.username, handle.domain);
    if (cached.isOk() && cached.value) {
      actors.set(cached.value.actorUri, cached.value);
      continue;
    }
    const resolved = await resolveRemoteActorByHandle(
      env.DB,
      identity,
      `${handle.username}@${handle.domain}`,
      { allowHosts, blockedHosts },
    );
    if (resolved.isOk()) {
      actors.set(resolved.value.actorUri, resolved.value);
    }
  }
  return [...actors.values()];
};

/** The `Mention` tags of a local note, from its stored local and remote mentions. */
export const loadNoteMentions = async (
  db: D1Database,
  identity: InstanceIdentity,
  statusId: string,
): Promise<ReadonlyArray<NoteMention>> => {
  const mentions = await listStatusMentions(db, [statusId]);
  const entry = mentions.isOk() ? mentions.value.get(statusId) : undefined;
  if (!entry) {
    return [];
  }
  const [accounts, actors] = await Promise.all([
    findAccountsByIds(db, entry.accountIds),
    findRemoteActorsByUris(db, entry.actorUris),
  ]);
  return [
    ...(accounts.isOk() ? [...accounts.value.values()] : []).map((account) => ({
      href: InstanceIdentity.actorUrl(identity, account.username),
      name: `@${account.username}@${identity.domain}`,
    })),
    ...(actors.isOk() ? [...actors.value.values()] : []).map((actor) => ({
      href: actor.actorUri,
      name: `@${actor.username}@${actor.domain}`,
    })),
  ];
};
