import {
  type LocalStatusValue,
  type RemoteStatusValue,
  StatusTarget,
  type StatusTargetValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { availableAccountIds } from "./account-presentation";
import type { RepositoryError } from "./d1";
import { RemoteAccountId } from "./remote-account-id";
import { findRemoteStatusById } from "./remote-status-store";
import { findStatusById } from "./status-store";
import { canViewRemoteStatus, canViewStatus } from "./visibility-guard";

/** A status found by id: a local one, or a cached remote one. */
export type FoundStatus =
  | Readonly<{ kind: "LocalStatus"; status: LocalStatusValue }>
  | Readonly<{ kind: "RemoteStatus"; status: RemoteStatusValue }>;

/** The local or cached remote status with this id; ids are shared, so at most one matches. */
export const findStatusAnywhere = async (
  db: D1Database,
  id: string,
): Promise<Result<FoundStatus | undefined, RepositoryError>> => {
  const local = await findStatusById(db, id);
  if (local.isErr()) {
    return err(local.error);
  }
  if (local.value) {
    return ok({ kind: "LocalStatus", status: local.value });
  }
  const remote = await findRemoteStatusById(db, id);
  return remote.map((status) => status && { kind: "RemoteStatus", status });
};

const canViewFoundStatus = (
  db: D1Database,
  found: FoundStatus,
  viewerId: string | undefined,
): Promise<boolean> =>
  found.kind === "LocalStatus"
    ? canViewStatus(db, found.status, viewerId)
    : canViewRemoteStatus(db, found.status, viewerId);

/**
 * Mastodon's `StatusPolicy#show?`: the status's author is available and the
 * viewer may see the status.
 */
export const showsFoundStatus = async (
  env: Env,
  found: FoundStatus,
  viewerId: string | undefined,
): Promise<Result<boolean, RepositoryError>> => {
  const authorId =
    found.kind === "LocalStatus"
      ? found.status.accountId
      : RemoteAccountId.encode(found.status.actorUri);
  const available = await availableAccountIds(env, [authorId]);
  if (available.isErr()) {
    return err(available.error);
  }
  return ok(available.value.has(authorId) && (await canViewFoundStatus(env.DB, found, viewerId)));
};

/** The local or cached remote status with this id, when {@link showsFoundStatus}. */
export const findShownStatusAnywhere = async (
  env: Env,
  id: string,
  viewerId: string | undefined,
): Promise<Result<FoundStatus | undefined, RepositoryError>> => {
  const found = await findStatusAnywhere(env.DB, id);
  if (found.isErr() || !found.value) {
    return found;
  }
  const status = found.value;
  return (await showsFoundStatus(env, status, viewerId)).map((shown) =>
    shown ? status : undefined,
  );
};

export const foundStatusTarget = (found: FoundStatus): StatusTargetValue =>
  found.kind === "LocalStatus"
    ? StatusTarget.local(found.status.id)
    : StatusTarget.remote(found.status.id);
