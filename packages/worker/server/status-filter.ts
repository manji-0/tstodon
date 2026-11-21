import { RemoteActor, type ThreadStatus } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, type RepositoryError, runD1 } from "./d1";
import { listUnfollowedSilencedAuthorsJson } from "./generated/prisma/sql";
import { listSuppressedAuthors } from "./block-mute-store";
import { listBlockedDomains } from "./domain-block-store";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { queryTyped } from "./typed-sql";
import { viewableStatusIds } from "./visibility-guard";

const AuthorRow = z.object({ author: z.string() });

/** The silenced authors of `statuses` the viewer neither follows nor is; `undefined` if unknown. */
const listUnfollowedSilencedAuthors = async (
  db: D1Database,
  statuses: ReadonlyArray<ThreadStatus>,
  viewerId: string | undefined,
): Promise<ReadonlySet<string> | undefined> => {
  const accountIds = statuses.flatMap((node) =>
    node.kind === "Local" ? [node.status.accountId] : [],
  );
  const actorUris = statuses.flatMap((node) =>
    node.kind === "Remote" ? [node.status.actorUri] : [],
  );
  if (accountIds.length === 0 && actorUris.length === 0) {
    return new Set();
  }
  const rows = await runD1(() =>
    queryTyped(
      db,
      listUnfollowedSilencedAuthorsJson(
        viewerId ?? "",
        jsonStringArray([...new Set(accountIds)]),
        jsonStringArray([...new Set(actorUris)]),
      ),
      AuthorRow,
    ),
  );
  if (rows.isErr()) {
    console.error(
      JSON.stringify({ kind: "SilencedAuthorsNotLoaded", message: rows.error.message }),
    );
    return undefined;
  }
  return new Set(rows.value.map((row) => row.author));
};

/**
 * What a viewer's lookup found: nothing without a viewer, `undefined`
 * (logged) when it failed.
 */
const loaded = <T>(
  kind: string,
  found: Result<T, RepositoryError> | undefined,
  none: T,
): T | undefined => {
  if (found === undefined) {
    return none;
  }
  if (found.isErr()) {
    console.error(JSON.stringify({ kind, message: found.error.message }));
    return undefined;
  }
  return found.value;
};

/**
 * Mastodon's `Status.permitted_statuses_from_ids`: the ids of `statuses` that
 * `StatusFilter#filtered?` keeps for the viewer. A status is left out when
 * `StatusPolicy#show?` refuses it, when the viewer blocks or mutes its author
 * or is blocked by it, when the viewer blocks its author's domain, or when
 * its author is silenced (on its own or by its domain) and the viewer does
 * not follow it. The viewer's own statuses are kept. A remote status whose
 * actor is not cached is left out too. A suspended author's status is not
 * rendered, so the renderer leaves it out. A lookup that fails leaves out
 * every status but the viewer's own.
 */
export const permittedStatusIds = async (
  db: D1Database,
  statuses: ReadonlyArray<ThreadStatus>,
  viewerId: string | undefined,
): Promise<ReadonlySet<string>> => {
  const [suppressed, own, actors, silenced, viewable] = await Promise.all([
    viewerId ? listSuppressedAuthors(db, viewerId) : undefined,
    viewerId ? listBlockedDomains(db, viewerId) : undefined,
    findRemoteActorsByUris(
      db,
      statuses.flatMap((node) => (node.kind === "Remote" ? [node.status.actorUri] : [])),
    ),
    listUnfollowedSilencedAuthors(db, statuses, viewerId),
    viewableStatusIds(
      db,
      statuses.flatMap((node) => (node.kind === "Local" ? [node.status] : [])),
      statuses.flatMap((node) => (node.kind === "Remote" ? [node.status] : [])),
      viewerId,
    ),
  ]);
  const authors = loaded("SuppressedAuthorsNotLoaded", suppressed, {
    accountIds: new Set<string>(),
    actorUris: new Set<string>(),
  });
  const blocked = loaded("BlockedDomainsNotLoaded", own, []);
  const domains = blocked && new Set(blocked);
  const isSilenced = (author: string): boolean => silenced === undefined || silenced.has(author);
  const hidden = (node: ThreadStatus): boolean => {
    if (node.kind === "Local" && node.status.accountId === viewerId) {
      return false;
    }
    if (authors === undefined || domains === undefined) {
      return true;
    }
    if (node.kind === "Local") {
      return authors.accountIds.has(node.status.accountId) || isSilenced(node.status.accountId);
    }
    const actor = actors.isOk() ? actors.value.get(node.status.actorUri) : undefined;
    return (
      authors.actorUris.has(node.status.actorUri) ||
      !actor ||
      RemoteActor.onAnyHost(actor, domains) ||
      isSilenced(node.status.actorUri)
    );
  };
  return new Set(
    statuses.flatMap((node) =>
      !hidden(node) && viewable.has(node.status.id) ? [node.status.id] : [],
    ),
  );
};
