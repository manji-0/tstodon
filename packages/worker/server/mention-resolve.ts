import { InstanceIdentity, RemoteActor, Hostname } from "@tstodon/domain";
import type { LocalAccount } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountsByIds, findAccountsByUsernames } from "./account-store";
import type { RepositoryError } from "./d1";
import type { NoteMention } from "./activitypub";
import { listStatusMentions } from "./mention-store";
import { suspendedDomains } from "./admin-domain-block-store";
import { mentionUsernames, remoteMentionHandles, type PostMention } from "./html";
import { resolveRemoteActorByHandle } from "./remote-actor-fetch";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { allowListAdmits, federationAllowHosts } from "./runtime-config";
import { instanceActorFetchSigner } from "./instance-actor";

const MAX_MENTION_LOOKUPS = 20;

/**
 * Remote actors a post's `@user@domain` handles name, as
 * `resolveRemoteActorByHandle` finds them: the cached actor while its
 * confirmation is under a day old, otherwise re-confirmed or resolved over
 * WebFinger. A handle on a suspended or non-federating domain, an actor
 * whose account domain or URI host is one, or a handle that does not resolve,
 * is left out and the post goes ahead, as in Mastodon. Unlike Mastodon, at
 * most `MAX_MENTION_LOOKUPS` handles go to the network per post; one lookup
 * can chain several WebFinger and actor fetches, so a post naming many
 * uncached handles would otherwise run for minutes. Handles past the cap
 * resolve from the cache only.
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
  const fetchSigner = instanceActorFetchSigner(env.DB, identity);
  let lookUpsLeft = MAX_MENTION_LOOKUPS;
  const mayLookUp = (): boolean => {
    if (lookUpsLeft === 0) {
      return false;
    }
    lookUpsLeft -= 1;
    return true;
  };
  const actors = new Map<string, RemoteActor>();
  for (const handle of handles) {
    if (blockedHosts.has(Hostname.ofAuthority(handle.domain))) {
      continue;
    }
    const resolved = await resolveRemoteActorByHandle(
      env.DB,
      identity,
      `${handle.username}@${handle.domain}`,
      { allowHosts, blockedHosts, mayLookUp, fetchSigner },
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

/** The accounts post text mentions that exist: local accounts, and remote actors that resolve. */
export type ResolvedMentions = Readonly<{
  locals: ReadonlyArray<LocalAccount>;
  remotes: ReadonlyArray<RemoteActor>;
}>;

export const resolveMentions = async (
  env: Env,
  identity: InstanceIdentity,
  text: string,
): Promise<Result<ResolvedMentions, RepositoryError>> => {
  const locals = await findAccountsByUsernames(env.DB, [
    ...mentionUsernames(text, identity.domain),
  ]);
  return locals.isErr()
    ? err(locals.error)
    : ok({ locals: locals.value, remotes: await resolveRemoteMentions(env, identity, text) });
};

/** What `formatPostText` links each resolved mention to: the REST `mentions[].url`. */
export const mentionLinks = (
  identity: InstanceIdentity,
  resolved: ResolvedMentions,
): ReadonlyArray<PostMention> => [
  ...resolved.locals.map((account) => ({
    username: account.username,
    domain: null,
    url: InstanceIdentity.actorUrl(identity, account.username),
  })),
  ...resolved.remotes.map((actor) => ({
    username: actor.username,
    domain: actor.domain,
    url: actor.actorUri,
  })),
];

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
