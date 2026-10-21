import { InstanceIdentity } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountsByIds } from "./account-store";
import { parseLocalStatusId } from "./activitypub";
import type { RepositoryError } from "./d1";
import type { ReplyTarget } from "./reply-target";
import {
  findRemoteStatusByObjectUri,
  findRemoteStatusReplyTargets,
  listRemoteRepliesToUris,
} from "./remote-status-store";
import {
  findStatusById,
  listLocalRepliesToUris,
  listLocalRepliesToIds,
  listStatusReplyUris,
} from "./status-store";
import { canViewRemoteStatus, canViewStatus } from "./visibility-guard";

/** A status in a thread: a local one or a cached remote one. */
export type ThreadStatus = ReplyTarget;

const parentOf = async (
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
  const parent = await findRemoteStatusByObjectUri(db, parentUri);
  if (parent.isErr()) {
    return err(parent.error);
  }
  return ok(parent.value ? { kind: "Remote", status: parent.value } : undefined);
};

/**
 * The statuses above one in its thread, oldest first, across local and
 * remote parents. A status seen twice (a forged `inReplyTo` loop) ends it.
 */
export const listThreadAncestors = async (
  db: D1Database,
  identity: InstanceIdentity,
  start: ThreadStatus,
  depth: number,
): Promise<Result<ThreadStatus[], RepositoryError>> => {
  const chain: ThreadStatus[] = [];
  const seen = new Set<string>([start.status.id]);
  let current = start;
  for (let step = 0; step < depth; step += 1) {
    const parent = await parentOf(db, identity, current);
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

/**
 * Replies below a status, breadth-first and ordered by id like the local
 * walk: local replies by `in_reply_to_id`, and replies naming a status by URI
 * — remote ones to anything, local ones to a remote status.
 */
export const listThreadDescendants = async (
  db: D1Database,
  identity: InstanceIdentity,
  start: ThreadStatus,
  limit: number,
  depth: number,
): Promise<Result<ThreadStatus[], RepositoryError>> => {
  const collected: ThreadStatus[] = [];
  const seen = new Set<string>([start.status.id]);
  let frontier: ThreadStatus[] = [start];
  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const remaining = limit - collected.length;
    if (remaining <= 0) {
      break;
    }
    const localIds = frontier.flatMap((node) => (node.kind === "Local" ? [node.status.id] : []));
    const authors = await findAccountsByIds(
      db,
      frontier.flatMap((node) => (node.kind === "Local" ? [node.status.accountId] : [])),
    );
    if (authors.isErr()) {
      return err(authors.error);
    }
    const localUris = frontier.flatMap((node) => {
      const author = node.kind === "Local" ? authors.value.get(node.status.accountId) : undefined;
      return author
        ? [`${InstanceIdentity.actorUrl(identity, author.username)}/statuses/${node.status.id}`]
        : [];
    });
    const remoteUris = frontier.flatMap((node) =>
      node.kind === "Remote" ? [node.status.objectUri] : [],
    );
    const [localChildren, localRepliesToRemote, remoteChildren] = await Promise.all([
      listLocalRepliesToIds(db, localIds, remaining),
      listLocalRepliesToUris(db, remoteUris, remaining),
      listRemoteRepliesToUris(db, [...localUris, ...remoteUris], remaining),
    ]);
    if (localChildren.isErr()) {
      return err(localChildren.error);
    }
    if (localRepliesToRemote.isErr()) {
      return err(localRepliesToRemote.error);
    }
    if (remoteChildren.isErr()) {
      return err(remoteChildren.error);
    }
    const children: ThreadStatus[] = [
      ...localChildren.value.map((status): ThreadStatus => ({ kind: "Local", status })),
      ...localRepliesToRemote.value.map((status): ThreadStatus => ({ kind: "Local", status })),
      ...remoteChildren.value.map((status): ThreadStatus => ({ kind: "Remote", status })),
    ];
    const next: ThreadStatus[] = [];
    for (const child of children.toSorted((left, right) =>
      left.status.id.localeCompare(right.status.id),
    )) {
      if (seen.has(child.status.id) || collected.length >= limit) {
        continue;
      }
      seen.add(child.status.id);
      collected.push(child);
      next.push(child);
    }
    frontier = next;
  }
  return ok(collected.toSorted((left, right) => left.status.id.localeCompare(right.status.id)));
};

/** Keep the thread statuses the viewer may see. */
export const visibleThreadStatuses = async (
  db: D1Database,
  statuses: ReadonlyArray<ThreadStatus>,
  viewerId: string | undefined,
): Promise<ThreadStatus[]> =>
  (
    await Promise.all(
      statuses.map(async (node) =>
        (
          node.kind === "Local"
            ? await canViewStatus(db, node.status, viewerId)
            : await canViewRemoteStatus(db, node.status, viewerId)
        )
          ? [node]
          : [],
      ),
    )
  ).flat();
