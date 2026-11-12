import {
  InstanceIdentity,
  type LocalStatus,
  RemoteActor,
  type RemoteStatus,
  type ThreadStatus,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { parseLocalStatusId } from "./activitypub";
import { type RepositoryError, runD1, storedRowError } from "./d1";
import {
  listLocalThreadAncestors as listLocalThreadAncestorsSql,
  listRemoteThreadAncestors as listRemoteThreadAncestorsSql,
  listThreadDescendantIds as listThreadDescendantIdsSql,
} from "./generated/prisma/sql";
import {
  findDeliveredRemoteStatus,
  findRemoteStatusesByIds,
  readableRemoteStatus,
  remoteStatusFromRow,
  RemoteStatusRowSchema,
} from "./remote-status-store";
import { findRemoteStatusReplyTargets } from "./remote-reply-store";
import {
  findStatusById,
  findStatusesByIds,
  hydrateStatusRows,
  listStatusReplyUris,
  StatusRowSchema,
} from "./status-store";
import { queryTyped } from "./typed-sql";
import { viewableStatusIds } from "./visibility-guard";
import { restrictedDomains } from "./admin-domain-block-store";
import { listBlockedDomains } from "./domain-block-store";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { listSuppressedAuthors } from "./block-mute-store";

/** The D1 lookup behind `FindThreadParent`. */
export const findThreadParent = async (
  db: D1Database,
  identity: InstanceIdentity,
  node: ThreadStatus,
): Promise<Result<ThreadStatus | undefined, RepositoryError>> => {
  let parentUri: string | undefined;
  if (node.kind === "Local") {
    if (node.status.kind !== "LocalNote") {
      return ok(undefined);
    }
    if (node.status.inReplyToId) {
      const parent = await findStatusById(db, node.status.inReplyToId);
      if (parent.isErr()) {
        return err(parent.error);
      }
      return ok(parent.value ? { kind: "Local", status: parent.value } : undefined);
    }
    const uris = await listStatusReplyUris(db, [node.status.id]);
    if (uris.isErr()) {
      return err(uris.error);
    }
    parentUri = uris.value.get(node.status.id);
  } else {
    const targets = await findRemoteStatusReplyTargets(db, [node.status.id]);
    if (targets.isErr()) {
      return err(targets.error);
    }
    parentUri = targets.value.get(node.status.id)?.inReplyToUri;
  }
  if (!parentUri) {
    return ok(undefined);
  }
  const localId = parseLocalStatusId(identity, parentUri);
  if (localId) {
    const parent = await findStatusById(db, localId);
    if (parent.isErr()) {
      return err(parent.error);
    }
    return ok(parent.value ? { kind: "Local", status: parent.value } : undefined);
  }
  // A parent whose row does not read is unknown, as one that was never stored.
  const parent = readableRemoteStatus(await findDeliveredRemoteStatus(db, parentUri));
  if (parent.isErr()) {
    return err(parent.error);
  }
  return ok(parent.value ? { kind: "Remote", status: parent.value } : undefined);
};

const LocalAncestorRow = StatusRowSchema.extend({
  in_reply_to_uri: z.string().nullable(),
  depth: z.number(),
});
const RemoteAncestorRow = RemoteStatusRowSchema.extend({
  in_reply_to_uri: z.string().nullable(),
  depth: z.number(),
});

/**
 * The statuses above one in its thread, oldest first, across local and
 * remote parents: each step is the parent {@link findThreadParent} finds. A
 * status seen twice (a forged `inReplyTo` loop) ends it. Each unbroken run of
 * local or of remote parents loads in one recursive query.
 */
export const listThreadAncestors = async (
  db: D1Database,
  identity: InstanceIdentity,
  start: ThreadStatus,
  depth: number,
): Promise<Result<ThreadStatus[], RepositoryError>> => {
  const locals = new Map<string, LocalStatus>();
  const localReplyUris = new Map<string, string | undefined>();
  /** Local ids whose `in_reply_to_id` parent was looked up: one absent here is missing. */
  const localWalked = new Set<string>();
  const remotes = new Map<string, RemoteStatus>();
  const remoteReplyUris = new Map<string, string | undefined>();
  /** Object URIs looked up among cached remote statuses: one absent here is missing. */
  const remoteWalked = new Set<string>();

  /** Load the local status `id` and the run of local parents above it. */
  const loadLocalRun = async (
    id: string,
    steps: number,
  ): Promise<Result<void, RepositoryError>> => {
    const rows = await runD1(async () =>
      queryTyped(db, listLocalThreadAncestorsSql(id, steps), LocalAncestorRow),
    );
    if (rows.isErr()) {
      return err(rows.error);
    }
    const statuses = await runD1(() => hydrateStatusRows(db, rows.value));
    if (statuses.isErr()) {
      return err(statuses.error);
    }
    for (const status of statuses.value) {
      locals.set(status.id, status);
    }
    for (const row of rows.value) {
      localReplyUris.set(row.id, row.in_reply_to_uri ?? undefined);
      if (row.depth < steps) {
        localWalked.add(row.id);
      }
    }
    return ok(undefined);
  };

  /** Load the cached remote status at `uri` and the run of remote parents above it. */
  const loadRemoteRun = async (
    uri: string,
    steps: number,
  ): Promise<Result<void, RepositoryError>> => {
    const rows = await runD1(async () =>
      queryTyped(db, listRemoteThreadAncestorsSql(uri, steps), RemoteAncestorRow),
    );
    if (rows.isErr()) {
      return err(rows.error);
    }
    remoteWalked.add(uri);
    for (const row of rows.value) {
      const status = remoteStatusFromRow(row);
      if (status.isErr()) {
        return err(storedRowError(status.error));
      }
      remotes.set(row.object_uri, status.value);
      remoteReplyUris.set(row.id, row.in_reply_to_uri ?? undefined);
      if (row.depth < steps && row.in_reply_to_uri) {
        remoteWalked.add(row.in_reply_to_uri);
      }
    }
    return ok(undefined);
  };

  const localById = async (
    id: string,
    steps: number,
  ): Promise<Result<ThreadStatus | undefined, RepositoryError>> => {
    if (!locals.has(id)) {
      const loaded = await loadLocalRun(id, steps);
      if (loaded.isErr()) {
        return err(loaded.error);
      }
    }
    const status = locals.get(id);
    return ok(status ? { kind: "Local", status } : undefined);
  };

  const parentByUri = async (
    uri: string,
    steps: number,
  ): Promise<Result<ThreadStatus | undefined, RepositoryError>> => {
    const localId = parseLocalStatusId(identity, uri);
    if (localId) {
      return localById(localId, steps);
    }
    if (!remoteWalked.has(uri)) {
      const loaded = await loadRemoteRun(uri, steps);
      if (loaded.isErr()) {
        return err(loaded.error);
      }
    }
    const status = remotes.get(uri);
    return ok(status ? { kind: "Remote", status } : undefined);
  };

  /** `node`'s parent, `steps` the parents still wanted from it on up. */
  const parentOf = async (
    node: ThreadStatus,
    steps: number,
  ): Promise<Result<ThreadStatus | undefined, RepositoryError>> => {
    if (node.kind === "Remote") {
      if (!remoteReplyUris.has(node.status.id)) {
        const targets = await findRemoteStatusReplyTargets(db, [node.status.id]);
        if (targets.isErr()) {
          return err(targets.error);
        }
        remoteReplyUris.set(node.status.id, targets.value.get(node.status.id)?.inReplyToUri);
      }
      const uri = remoteReplyUris.get(node.status.id);
      return uri ? parentByUri(uri, steps) : ok(undefined);
    }
    if (node.status.kind !== "LocalNote") {
      return ok(undefined);
    }
    if (!localWalked.has(node.status.id)) {
      // The node itself heads the run, at depth 0.
      const loaded = await loadLocalRun(node.status.id, steps);
      if (loaded.isErr()) {
        return err(loaded.error);
      }
    }
    if (node.status.inReplyToId) {
      const parent = locals.get(node.status.inReplyToId);
      return ok(parent ? { kind: "Local", status: parent } : undefined);
    }
    const uri = localReplyUris.get(node.status.id);
    return uri ? parentByUri(uri, steps) : ok(undefined);
  };

  const chain: ThreadStatus[] = [];
  const seen = new Set<string>([start.status.id]);
  let current = start;
  for (let step = 0; step < depth; step += 1) {
    const parent = await parentOf(current, depth - step);
    if (parent.isErr()) {
      return err(parent.error);
    }
    if (!parent.value || seen.has(parent.value.status.id)) {
      break;
    }
    seen.add(parent.value.status.id);
    chain.push(parent.value);
    current = parent.value;
  }
  return ok(chain.reverse());
};

const DescendantIdRow = z.object({
  kind: z.literal(["Local", "Remote"]),
  id: z.string(),
  depth: z.number(),
});

/**
 * Rows the reply-tree query may produce before it stops, however many
 * replies the response keeps: a bound on one thread's cost.
 */
const MAX_THREAD_TREE_ROWS = 2_000;

/**
 * Replies below a status, breadth-first and ordered by id within each level:
 * local replies by `in_reply_to_id`, and replies naming a status by URI —
 * remote ones to anything, local ones to a remote status. One recursive
 * query walks the tree; the statuses then load in one concurrent round.
 */
export const listThreadDescendants = async (
  db: D1Database,
  identity: InstanceIdentity,
  start: ThreadStatus,
  limit: number,
  depth: number,
): Promise<Result<ThreadStatus[], RepositoryError>> => {
  if (limit <= 0 || depth <= 0) {
    return ok([]);
  }
  const rows = await runD1(async () =>
    queryTyped(
      db,
      listThreadDescendantIdsSql(
        start.kind,
        start.status.id,
        `${InstanceIdentity.actorUrl(identity, "")}`,
        depth,
        Math.max(MAX_THREAD_TREE_ROWS, limit),
      ),
      DescendantIdRow,
    ),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  const picked = rows.value.slice(0, limit);
  const [locals, remotes] = await Promise.all([
    findStatusesByIds(
      db,
      picked.flatMap((row) => (row.kind === "Local" ? [row.id] : [])),
    ),
    findRemoteStatusesByIds(
      db,
      picked.flatMap((row) => (row.kind === "Remote" ? [row.id] : [])),
    ),
  ]);
  if (locals.isErr()) {
    return err(locals.error);
  }
  if (remotes.isErr()) {
    return err(remotes.error);
  }
  const collected = picked.flatMap((row): ThreadStatus[] => {
    if (row.kind === "Local") {
      const status = locals.value.get(row.id);
      return status ? [{ kind: "Local", status }] : [];
    }
    const status = remotes.value.get(row.id);
    return status ? [{ kind: "Remote", status }] : [];
  });
  return ok(collected.toSorted((left, right) => left.status.id.localeCompare(right.status.id)));
};

/**
 * The ids of the thread statuses the viewer may see, without authors they
 * block or mute (or who block them), remote actors on domains they block, or
 * domains the instance limits or suspends — as remote timelines leave them out.
 */
export const visibleThreadStatusIds = async (
  db: D1Database,
  statuses: ReadonlyArray<ThreadStatus>,
  viewerId: string | undefined,
): Promise<ReadonlySet<string>> => {
  const [suppressed, restricted, own, actors, viewable] = await Promise.all([
    viewerId ? listSuppressedAuthors(db, viewerId) : undefined,
    restrictedDomains(db),
    viewerId ? listBlockedDomains(db, viewerId) : undefined,
    findRemoteActorsByUris(
      db,
      statuses.flatMap((node) => (node.kind === "Remote" ? [node.status.actorUri] : [])),
    ),
    viewableStatusIds(
      db,
      statuses.flatMap((node) => (node.kind === "Local" ? [node.status] : [])),
      statuses.flatMap((node) => (node.kind === "Remote" ? [node.status] : [])),
      viewerId,
    ),
  ]);
  const blockedDomains = new Set(own?.isOk() ? own.value : []);
  const hidden = (node: ThreadStatus): boolean => {
    if (node.kind === "Local") {
      return suppressed?.isOk() === true && suppressed.value.accountIds.has(node.status.accountId);
    }
    if (suppressed?.isOk() && suppressed.value.actorUris.has(node.status.actorUri)) {
      return true;
    }
    const actor = actors.isOk() ? actors.value.get(node.status.actorUri) : undefined;
    return (
      !actor ||
      RemoteActor.onAnyHost(actor, blockedDomains) ||
      RemoteActor.onAnyHost(actor, restricted)
    );
  };
  return new Set(
    statuses.flatMap((node) =>
      !hidden(node) && viewable.has(node.status.id) ? [node.status.id] : [],
    ),
  );
};
