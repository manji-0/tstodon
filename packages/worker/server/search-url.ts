import type { InstanceIdentity, LocalAccount, RemoteActor } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { findAccountByUsername } from "./account-store";
import type { RepositoryError } from "./d1";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import { type FoundStatus, showsFoundStatus } from "./found-status";
import { cacheFetchedActor, remoteActorFromDocument } from "./remote-actor-fetch";
import { findRemoteActorByUri } from "./remote-actor-store";
import { findStoredNote, storeNoteDocument } from "./remote-status-persist";
import { findStatusById } from "./status-store";

/** Whether a search query is a URL, which `resolve=true` looks up instead of searching text. */
export const isUrlQuery = (query: string): boolean => /^https?:\/\/\S+$/.test(query);

/** What a URL names, for search: Mastodon's `ResolveURLService` answers a status or an account. */
export type UrlResource =
  | Readonly<{ kind: "Status"; status: FoundStatus }>
  | Readonly<{ kind: "LocalAccount"; account: LocalAccount }>
  | Readonly<{ kind: "RemoteAccount"; actor: RemoteActor }>;

type Resolved = Promise<Result<UrlResource | undefined, RepositoryError>>;

/** What a path on this instance names: a status (`/users/alice/statuses/1`, `/@alice/1`) or an account (`/users/alice`, `/@alice`). */
type LocalRef =
  | Readonly<{ kind: "Status"; username: string; id: string }>
  | Readonly<{ kind: "Account"; username: string }>;

const localRef = (path: string): LocalRef | undefined => {
  const status =
    /^\/users\/([^/]+)\/statuses\/([^/]+)\/?$/.exec(path) ?? /^\/@([^/@]+)\/([^/]+)\/?$/.exec(path);
  if (status?.[1] && status[2]) {
    return { kind: "Status", username: status[1], id: status[2] };
  }
  const account = /^\/users\/([^/]+)\/?$/.exec(path) ?? /^\/@([^/@]+)\/?$/.exec(path);
  return account?.[1] ? { kind: "Account", username: account[1] } : undefined;
};

/**
 * The username of a `user@domain` (or `@user@domain`) query whose domain is
 * this instance's: such a handle names a local account, as Mastodon's
 * `AccountSearchService` (`domain_is_local?`), and is never looked up over
 * WebFinger.
 */
export const localHandleUsername = (
  identity: InstanceIdentity,
  query: string,
): string | undefined => {
  const match = /^@?([^\s@]+)@([^\s@]+)$/.exec(query.trim());
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const domain = match[2].toLowerCase();
  return domain === identity.domain || domain === URL.parse(identity.publicOrigin)?.host
    ? match[1]
    : undefined;
};

/** A URL on this instance is read here and never fetched (`ResolveURLService#process_local_url`). */
const resolveLocalUrl = async (env: Env, path: string): Resolved => {
  const ref = localRef(path);
  if (!ref) {
    return ok(undefined);
  }
  const account = await findAccountByUsername(env.DB, ref.username);
  if (account.isErr()) {
    return err(account.error);
  }
  if (!account.value) {
    return ok(undefined);
  }
  if (ref.kind === "Account") {
    return ok({ kind: "LocalAccount", account: account.value });
  }
  const status = await findStatusById(env.DB, ref.id);
  if (status.isErr()) {
    return err(status.error);
  }
  // The URL names its author: `/@bob/<alice's id>` is no status, as the route answers 404.
  return ok(
    status.value?.kind === "LocalNote" && status.value.accountId === account.value.id
      ? { kind: "Status", status: { kind: "LocalStatus", status: status.value } }
      : undefined,
  );
};

/** What is already stored under a remote URI: a note this server holds, or a cached actor. */
const storedRemote = async (
  env: Env,
  identity: InstanceIdentity,
  uri: string,
): Promise<
  Result<Readonly<{ resource: UrlResource | undefined }> | undefined, RepositoryError>
> => {
  const stored = await findStoredNote(env, identity, uri);
  if (stored.isErr()) {
    return err(stored.error);
  }
  if (stored.value) {
    const note = stored.value.note;
    return ok({
      resource: note && { kind: "Status", status: { kind: "RemoteStatus", status: note } },
    });
  }
  return (await findRemoteActorByUri(env.DB, uri)).map(
    (actor) => actor && { resource: { kind: "RemoteAccount", actor } },
  );
};

const parseIdentified = schemaResult(z.looseObject({ id: z.string().min(1) }));

/** Store the document `uri` served, whose id is `uri`, as the note or the actor it is. */
const storeDocument = async (
  env: Env,
  identity: InstanceIdentity,
  uri: string,
  raw: unknown,
  options: FederatedFetchOptions,
): Resolved => {
  const actor = remoteActorFromDocument(raw, uri);
  if (actor.isOk()) {
    const cached = await cacheFetchedActor(env.DB, identity, actor.value, options);
    if (cached.isErr()) {
      return cached.error.kind === "RepositoryError" ? err(cached.error) : ok(undefined);
    }
    return ok({ kind: "RemoteAccount", actor: cached.value });
  }
  return (await storeNoteDocument(env, identity, uri, raw, options)).map(
    (note) => note && { kind: "Status", status: { kind: "RemoteStatus", status: note } },
  );
};

/**
 * A remote URL, as Mastodon's `FetchResourceService`: what is stored under it
 * is used as it is, else the URL is fetched once. A document that names
 * another id (a page URL such as `https://host/@user/123` serves the note
 * whose id is its URI) is not trusted for that id: the id is looked up in
 * turn, stored or fetched once, and must then name itself.
 */
const resolveRemoteUrl = async (
  env: Env,
  identity: InstanceIdentity,
  url: string,
  options: FederatedFetchOptions,
): Resolved => {
  let uri = url;
  for (const terminal of [false, true]) {
    const stored = await storedRemote(env, identity, uri);
    if (stored.isErr()) {
      return err(stored.error);
    }
    if (stored.value) {
      return ok(stored.value.resource);
    }
    const raw = await fetchActivityJson(identity, uri, options);
    const identified = raw.isOk() ? parseIdentified(raw.value) : undefined;
    if (raw.isErr() || !identified?.isOk()) {
      return ok(undefined);
    }
    const id = identified.value.id;
    if (id === uri) {
      return storeDocument(env, identity, uri, raw.value, options);
    }
    if (terminal || !isUrlQuery(id) || URL.parse(id)?.origin === originOf(identity)) {
      return ok(undefined);
    }
    uri = id;
  }
  return ok(undefined);
};

const originOf = (identity: InstanceIdentity): string | undefined =>
  URL.parse(identity.publicOrigin)?.origin;

/**
 * The status or account a URL names, for the viewer: Mastodon's
 * `ResolveURLService`. A status the viewer may not see (`StatusPolicy#show?`)
 * is `undefined`, as is a URL that names neither.
 */
export const resolveSearchUrl = async (
  env: Env,
  identity: InstanceIdentity,
  url: string,
  viewerId: string | undefined,
  options: FederatedFetchOptions,
): Resolved => {
  const parsed = URL.parse(url);
  if (!parsed) {
    return ok(undefined);
  }
  const found =
    parsed.origin === originOf(identity)
      ? await resolveLocalUrl(env, parsed.pathname)
      : await resolveRemoteUrl(env, identity, url, options);
  if (found.isErr() || found.value?.kind !== "Status") {
    return found;
  }
  const resource = found.value;
  return (await showsFoundStatus(env, resource.status, viewerId)).map((shown) =>
    shown ? resource : undefined,
  );
};
