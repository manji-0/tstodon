import type { InstanceIdentity } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountByUsername } from "./account-store";
import type { RepositoryError } from "./d1";
import type { FederatedFetchOptions } from "./federated-fetch";
import { type FoundStatus, showsFoundStatus } from "./found-status";
import { persistFetchedObject } from "./remote-status-persist";
import { findStatusById } from "./status-store";

/** Whether a search query is a URL, which `resolve=true` looks up instead of searching text. */
export const isUrlQuery = (query: string): boolean => /^https?:\/\/\S+$/.test(query);

/** The author's username and the id in a local status's URI (`/users/alice/statuses/1`) or page URL (`/@alice/1`). */
const localStatusRef = (
  identity: InstanceIdentity,
  url: string,
): Readonly<{ username: string; id: string }> | undefined => {
  const origin = identity.publicOrigin.replace(/\/$/, "");
  if (!url.startsWith(`${origin}/`)) {
    return undefined;
  }
  const path = url.slice(origin.length);
  const match =
    /^\/users\/([^/]+)\/statuses\/([^/]+)\/?$/.exec(path) ?? /^\/@([^/@]+)\/([^/]+)\/?$/.exec(path);
  return match?.[1] && match[2] ? { username: match[1], id: match[2] } : undefined;
};

/** Whether `url` is on this instance: such a URL is never fetched. */
const isLocalUrl = (identity: InstanceIdentity, url: string): boolean =>
  URL.parse(url)?.origin === URL.parse(identity.publicOrigin)?.origin;

/**
 * The status a URL names, for the viewer: Mastodon's `ResolveURLService`. A
 * local status is read here. A remote one is the cached status, or the note
 * fetched from the URL and stored. `undefined` when the URL names no status,
 * or one the viewer may not see (`StatusPolicy#show?`).
 */
export const resolveStatusUrl = async (
  env: Env,
  identity: InstanceIdentity,
  url: string,
  viewerId: string | undefined,
  options: FederatedFetchOptions,
): Promise<Result<FoundStatus | undefined, RepositoryError>> => {
  let found: FoundStatus | undefined;
  if (isLocalUrl(identity, url)) {
    const ref = localStatusRef(identity, url);
    if (!ref) {
      return ok(undefined);
    }
    const local = await findStatusById(env.DB, ref.id);
    if (local.isErr()) {
      return err(local.error);
    }
    if (local.value?.kind !== "LocalNote") {
      return ok(undefined);
    }
    // The URL names its author: `/@bob/<alice's id>` is no status, as the route answers 404.
    const author = await findAccountByUsername(env.DB, ref.username);
    if (author.isErr()) {
      return err(author.error);
    }
    if (author.value?.id !== local.value.accountId) {
      return ok(undefined);
    }
    found = { kind: "LocalStatus", status: local.value };
  } else {
    const remote = await persistFetchedObject(env, identity, url, options);
    if (remote.isErr()) {
      return err(remote.error);
    }
    found = remote.value && { kind: "RemoteStatus", status: remote.value };
  }
  if (!found) {
    return ok(undefined);
  }
  const status = found;
  return (await showsFoundStatus(env, status, viewerId)).map((shown) =>
    shown ? status : undefined,
  );
};
