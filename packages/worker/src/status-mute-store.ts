import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { jsonStringArray, runD1, type RepositoryError } from "./d1";
import {
  listStatusMuteRoots as listStatusMuteRootsSql,
  listStatusReplyLinks as listStatusReplyLinksSql,
  muteStatus as muteStatusSql,
  unmuteStatus as unmuteStatusSql,
} from "./generated/prisma/sql";
import type {
  InstanceIdentity,
  LocalStatus,
  LocalStatus as LocalStatusValue,
} from "@tstodon/domain";
import { parseLocalStatusId } from "./activitypub";
import { findRemoteStatusReplyTargets } from "./remote-reply-store";
import { findRemoteStatusRefsByObjectUris } from "./remote-status-store";
import { findStatusesByIds } from "./status-store";
import { queryTyped, runTyped } from "./typed-sql";

/** Reply links (`id -> in_reply_to_id`) for the given status ids. */
const listStatusReplyLinks = async (
  db: D1Database,
  ids: ReadonlyArray<string>,
): Promise<Result<Map<string, string | null>, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string; in_reply_to_id: string | null }>(
      db,
      listStatusReplyLinksSql(jsonStringArray(ids)),
    );
    const links = new Map<string, string | null>();
    for (const row of rows) {
      links.set(row.id, row.in_reply_to_id);
    }
    return links;
  });

/** Resolve the thread root for each status by walking reply parents transitively. */
export const resolveThreadRootStatusIds = async (
  db: D1Database,
  statuses: ReadonlyArray<LocalStatus>,
): Promise<Result<ReadonlyMap<string, string>, RepositoryError>> => {
  const parentById = new Map<string, string | null>();
  for (const status of statuses) {
    parentById.set(status.id, status.kind === "LocalNote" ? status.inReplyToId : null);
  }
  for (let pass = 0; pass < 20; pass += 1) {
    const missing = new Set<string>();
    for (const parent of parentById.values()) {
      if (parent !== null && parent.length > 0 && !parentById.has(parent)) {
        missing.add(parent);
      }
    }
    if (missing.size === 0) {
      break;
    }
    const loaded = await listStatusReplyLinks(db, [...missing]);
    if (loaded.isErr()) {
      return err(loaded.error);
    }
    let added = 0;
    for (const [id, parent] of loaded.value) {
      if (!parentById.has(id)) {
        parentById.set(id, parent);
        added += 1;
      }
    }
    if (added === 0) {
      break;
    }
  }

  const roots = new Map<string, string>();
  for (const id of parentById.keys()) {
    let current = id;
    const seen = new Set<string>([id]);
    for (;;) {
      const parent = parentById.get(current) ?? null;
      if (parent === null || parent.length === 0 || seen.has(parent)) {
        break;
      }
      seen.add(parent);
      current = parent;
    }
    roots.set(id, current);
  }
  return ok(roots);
};

export const listStatusMuteRoots = async (
  db: D1Database,
  accountId: string,
): Promise<Result<ReadonlySet<string>, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ thread_root_status_id: string }>(
      db,
      listStatusMuteRootsSql(accountId),
    );
    return new Set(rows.map((row) => row.thread_root_status_id));
  });

export const muteStatusThread = async (
  db: D1Database,
  accountId: string,
  threadRootStatusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, muteStatusSql(accountId, threadRootStatusId, nowIso()));
  });

export const unmuteStatusThread = async (
  db: D1Database,
  accountId: string,
  threadRootStatusId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ thread_root_status_id: string }>(
      db,
      unmuteStatusSql(accountId, threadRootStatusId),
    );
    return rows.length > 0;
  });

/** How far up a remote reply chain to look for the local status it belongs under. */
const REMOTE_THREAD_DEPTH = 20;

/**
 * For remote statuses, the local status their reply chain reaches (walking
 * remote parents by URI), keyed by remote id. Chains that never reach a local
 * status are left out: only local threads can be muted.
 */
const remoteLocalAncestors = async (
  db: D1Database,
  identity: InstanceIdentity,
  remoteIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, string>, RepositoryError>> => {
  const reached = new Map<string, string>();
  // origin remote id -> the remote status reached so far on its chain
  let current = new Map(remoteIds.map((id) => [id, id]));
  const seen = new Set(remoteIds);
  for (let hop = 0; hop < REMOTE_THREAD_DEPTH && current.size > 0; hop += 1) {
    const targets = await findRemoteStatusReplyTargets(db, [...new Set(current.values())]);
    if (targets.isErr()) {
      return err(targets.error);
    }
    const parentUris = new Map<string, string>();
    for (const [origin, remoteId] of current) {
      const uri = targets.value.get(remoteId)?.inReplyToUri;
      if (!uri) {
        continue;
      }
      const localId = parseLocalStatusId(identity, uri);
      if (localId) {
        reached.set(origin, localId);
      } else {
        parentUris.set(origin, uri);
      }
    }
    const refs = await findRemoteStatusRefsByObjectUris(db, [...parentUris.values()]);
    if (refs.isErr()) {
      return err(refs.error);
    }
    const next = new Map<string, string>();
    for (const [origin, uri] of parentUris) {
      const parentId = refs.value.get(uri)?.id;
      if (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        next.set(origin, parentId);
      }
    }
    current = next;
  }
  return ok(reached);
};

/**
 * Of the given status ids — local, or cached remote ones replying into a local
 * thread — the ones whose conversation root the viewer muted.
 */
export const mutedThreadStatusIds = async (
  db: D1Database,
  identity: InstanceIdentity,
  accountId: string,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlySet<string>, RepositoryError>> => {
  const mutedRoots = await listStatusMuteRoots(db, accountId);
  if (mutedRoots.isErr()) {
    return err(mutedRoots.error);
  }
  if (mutedRoots.value.size === 0 || statusIds.length === 0) {
    return ok(new Set<string>());
  }
  const loaded = await findStatusesByIds(db, statusIds);
  if (loaded.isErr()) {
    return err(loaded.error);
  }
  // Ids that are not local statuses are remote ones; map each to the local
  // status its chain reaches, which then resolves to a root like any other.
  const ancestors = await remoteLocalAncestors(
    db,
    identity,
    statusIds.filter((id) => !loaded.value.has(id)),
  );
  if (ancestors.isErr()) {
    return err(ancestors.error);
  }
  const ancestorStatuses = await findStatusesByIds(db, [...new Set(ancestors.value.values())]);
  if (ancestorStatuses.isErr()) {
    return err(ancestorStatuses.error);
  }
  const roots = await resolveThreadRootStatusIds(db, [
    ...loaded.value.values(),
    ...ancestorStatuses.value.values(),
  ]);
  if (roots.isErr()) {
    return err(roots.error);
  }
  const muted = new Set<string>();
  for (const statusId of statusIds) {
    const localId = loaded.value.has(statusId) ? statusId : ancestors.value.get(statusId);
    const root = localId === undefined ? undefined : roots.value.get(localId);
    if (root !== undefined && mutedRoots.value.has(root)) {
      muted.add(statusId);
    }
  }
  return ok(muted);
};

export const filterMutedThreads = async (
  db: D1Database,
  accountId: string,
  statuses: ReadonlyArray<LocalStatusValue>,
): Promise<Result<LocalStatusValue[], RepositoryError>> => {
  const mutedRoots = await listStatusMuteRoots(db, accountId);
  if (mutedRoots.isErr()) {
    return err(mutedRoots.error);
  }
  if (mutedRoots.value.size === 0 || statuses.length === 0) {
    return ok([...statuses]);
  }
  const roots = await resolveThreadRootStatusIds(db, statuses);
  if (roots.isErr()) {
    return err(roots.error);
  }
  return ok(
    statuses.filter((status) => {
      const root = roots.value.get(status.id);
      return root === undefined || !mutedRoots.value.has(root);
    }),
  );
};
