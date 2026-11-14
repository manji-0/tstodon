import type { InstanceIdentity } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { parseLocalStatusId } from "./activitypub";
import type { RepositoryError } from "./d1";
import type { FederatedFetchOptions } from "./federated-fetch";
import { type FoundStatus, showsFoundStatus } from "./found-status";
import { persistFetchedObject } from "./remote-status-persist";
import { findStatusById } from "./status-store";

/** Whether a search query is a URL, which `resolve=true` looks up instead of searching text. */
export const isUrlQuery = (query: string): boolean => /^https?:\/\/\S+$/.test(query);

/** The id in a local status's URI (`/users/alice/statuses/1`) or page URL (`/@alice/1`). */
const localStatusId = (identity: InstanceIdentity, url: string): string | undefined => {
  const byUri = parseLocalStatusId(identity, url);
  if (byUri !== undefined) {
    return byUri;
  }
  const origin = identity.publicOrigin.replace(/\/$/, "");
  if (!url.startsWith(`${origin}/@`)) {
    return undefined;
  }
  return /^\/@[^/@]+\/(?:statuses\/)?([^/]+)\/?$/.exec(url.slice(origin.length))?.[1];
};

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
  const localId = localStatusId(identity, url);
  let found: FoundStatus | undefined;
  if (localId !== undefined) {
    const local = await findStatusById(env.DB, localId);
    if (local.isErr()) {
      return err(local.error);
    }
    found =
      local.value?.kind === "LocalNote" ? { kind: "LocalStatus", status: local.value } : undefined;
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
