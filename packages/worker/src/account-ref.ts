import { InstanceIdentity, type LocalAccount, type RemoteActor } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountByUsername } from "./account-store";
import { parseLocalActorUsername } from "./activitypub";
import { suspendedDomains } from "./admin-domain-block-store";
import type { RepositoryError } from "./d1";
import { RemoteAccountId } from "./remote-account-id";
import { resolveRemoteActorByHandle } from "./remote-actor-fetch";
import { findRemoteActorByHandle, findRemoteActorByUri } from "./remote-actor-store";
import { federationAllowHosts } from "./runtime-config";

/**
 * An account on either side of a move: a local account, or a cached remote
 * actor. `actorUri` is its ActivityPub id either way.
 */
export type AccountRef =
  | Readonly<{ kind: "LocalAccount"; account: LocalAccount; actorUri: string }>
  | Readonly<{ kind: "RemoteActor"; actor: RemoteActor; actorUri: string }>;

export const localRef = (identity: InstanceIdentity, account: LocalAccount): AccountRef => ({
  kind: "LocalAccount",
  account,
  actorUri: InstanceIdentity.actorUrl(identity, account.username),
});

export const remoteRef = (actor: RemoteActor): AccountRef => ({
  kind: "RemoteActor",
  actor,
  actorUri: actor.actorUri,
});

/** The Mastodon API id of the account: a local id, or an `r_…` id. */
export const refAccountId = (ref: AccountRef): string =>
  ref.kind === "LocalAccount" ? ref.account.id : RemoteAccountId.encode(ref.actorUri);

/** `user@domain` for a remote account, the bare username for a local one, as Mastodon's `acct`. */
export const refAcct = (ref: AccountRef): string =>
  ref.kind === "LocalAccount" ? ref.account.username : `${ref.actor.username}@${ref.actor.domain}`;

/** The local account or cached remote actor `actorUri` names; `undefined` when neither is known. */
export const findAccountRef = async (
  db: D1Database,
  identity: InstanceIdentity,
  actorUri: string,
): Promise<Result<AccountRef | undefined, RepositoryError>> => {
  const username = parseLocalActorUsername(identity, actorUri);
  if (username !== undefined) {
    const account = await findAccountByUsername(db, username);
    return account.map((found) => (found ? localRef(identity, found) : undefined));
  }
  const actor = await findRemoteActorByUri(db, actorUri);
  return actor.map((found) => (found ? remoteRef(found) : undefined));
};

export type ResolveHandleError =
  | Readonly<{ kind: "InvalidHandle" }>
  | Readonly<{ kind: "AccountNotFound" }>
  | RepositoryError;

/**
 * `user`, `@user`, `user@domain` or `@user@domain`, with Mastodon's
 * `USERNAME_RE` for the user part; a domain may carry a port.
 */
const HANDLE_PATTERN = /^@?([A-Za-z0-9_]+(?:[.-]+[A-Za-z0-9_]+)*)(?:@([A-Za-z0-9.-]+(?::\d+)?))?$/;

/** The parts of a handle that {@link HANDLE_PATTERN} accepts; the domain is lower case. */
export const parseAccountHandle = (
  raw: string,
): Readonly<{ username: string; domain: string | undefined }> | undefined => {
  const match = HANDLE_PATTERN.exec(raw.trim());
  const username = match?.[1];
  return match && username ? { username, domain: match[2]?.toLowerCase() } : undefined;
};

const findLocalRef = async (
  db: D1Database,
  identity: InstanceIdentity,
  username: string,
): Promise<Result<AccountRef, ResolveHandleError>> => {
  const account = await findAccountByUsername(db, username);
  if (account.isErr()) {
    return err(account.error);
  }
  return account.value ? ok(localRef(identity, account.value)) : err({ kind: "AccountNotFound" });
};

/**
 * The account a handle names among those this server already knows, as
 * Mastodon's `ResolveAccountService` with `skip_webfinger`: a bare username or
 * one at this instance's domain is local, anything else a cached remote actor.
 * Whether a read path may show it is `accountRefDocument`'s call.
 */
export const findKnownAccountHandle = async (
  env: Env,
  identity: InstanceIdentity,
  raw: string,
): Promise<Result<AccountRef, ResolveHandleError>> => {
  const handle = parseAccountHandle(raw);
  if (!handle) {
    return err({ kind: "InvalidHandle" });
  }
  const { username, domain } = handle;
  if (domain === undefined || domain === identity.domain) {
    return findLocalRef(env.DB, identity, username);
  }
  const actor = await findRemoteActorByHandle(env.DB, username, domain);
  if (actor.isErr()) {
    return err(actor.error);
  }
  return actor.value ? ok(remoteRef(actor.value)) : err({ kind: "AccountNotFound" });
};

/**
 * The account a handle names, as Mastodon's `ResolveAccountService`: a bare
 * username or one at this instance's domain is local; anything else is looked
 * up by WebFinger and its actor cached, within the federation limits.
 */
export const resolveAccountHandle = async (
  env: Env,
  identity: InstanceIdentity,
  raw: string,
): Promise<Result<AccountRef, ResolveHandleError>> => {
  const handle = parseAccountHandle(raw);
  if (!handle) {
    return err({ kind: "InvalidHandle" });
  }
  const { username, domain } = handle;
  if (domain === undefined || domain === identity.domain) {
    return findLocalRef(env.DB, identity, username);
  }
  const actor = await resolveRemoteActorByHandle(env.DB, identity, `${username}@${domain}`, {
    allowHosts: await federationAllowHosts(env),
    blockedHosts: await suspendedDomains(env.DB),
  });
  if (actor.isErr()) {
    return actor.error.kind === "RepositoryError"
      ? err(actor.error)
      : err({ kind: "AccountNotFound" });
  }
  return ok(remoteRef(actor.value));
};
