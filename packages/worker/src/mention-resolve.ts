import { InstanceIdentity, RemoteActor, Hostname } from "@tstodon/domain";
import { findAccountsByIds } from "./account-store";
import type { NoteMention } from "./activitypub";
import { listStatusMentions } from "./mention-store";
import { suspendedDomains } from "./admin-domain-block-store";
import { remoteMentionHandles } from "./html";
import { resolveRemoteActorByHandle } from "./remote-actor-fetch";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { allowListAdmits, federationAllowHosts } from "./runtime-config";

/**
 * Remote actors a post's `@user@domain` handles name, as
 * `resolveRemoteActorByHandle` finds them: the cached actor while its
 * confirmation is under a day old, otherwise re-confirmed or resolved over
 * WebFinger. A handle on a suspended or non-federating domain, an actor
 * whose account domain or URI host is one, or a handle that does not resolve,
 * is left out and the post goes ahead, as in Mastodon.
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
    if (blockedHosts.has(Hostname.ofAuthority(handle.domain))) {
      continue;
    }
    const resolved = await resolveRemoteActorByHandle(
      env.DB,
      identity,
      `${handle.username}@${handle.domain}`,
      { allowHosts, blockedHosts },
    );
    const admitted =
      resolved.isOk() &&
      RemoteActor.hostnames(resolved.value).every(
        (host) => !blockedHosts.has(host) && allowListAdmits(allowHosts, host),
      );
    if (resolved.isOk() && admitted) {
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
