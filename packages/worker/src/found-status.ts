import {
  type LocalStatusValue,
  type RemoteStatusValue,
  StatusTarget,
  type StatusTargetValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
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

export const canViewFoundStatus = (
  db: D1Database,
  found: FoundStatus,
  viewerId: string | undefined,
): Promise<boolean> =>
  found.kind === "LocalStatus"
    ? canViewStatus(db, found.status, viewerId)
    : canViewRemoteStatus(db, found.status, viewerId);

/** The local or cached remote status with this id, when the viewer may see it. */
export const findVisibleStatusAnywhere = async (
  db: D1Database,
  id: string,
  viewerId: string | undefined,
): Promise<Result<FoundStatus | undefined, RepositoryError>> => {
  const found = await findStatusAnywhere(db, id);
  if (found.isErr() || !found.value) {
    return found;
  }
  return ok((await canViewFoundStatus(db, found.value, viewerId)) ? found.value : undefined);
};

export const foundStatusTarget = (found: FoundStatus): StatusTargetValue =>
  found.kind === "LocalStatus"
    ? StatusTarget.local(found.status.id)
    : StatusTarget.remote(found.status.id);
