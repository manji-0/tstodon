import { FollowRequest, IsoInstant, RemoteActor } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, runD1, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { RemoteActorRowSchema, toRepositoryError } from "./schemas";
import { queryTyped, runTyped } from "./typed-sql";
import {
  authorizeRemoteFollowRequest as authorizeRemoteFollowRequestSql,
  deleteRemoteFollow as deleteRemoteFollowSql,
  findPendingRemoteFollowRequest as findPendingRemoteFollowRequestSql,
  findRemoteActorByPublicKeyId as findRemoteActorByPublicKeyIdSql,
  findRemoteActorByHandle as findRemoteActorByHandleSql,
  findRemoteActorByUri as findRemoteActorByUriSql,
  findRemoteActorsByUris as findRemoteActorsByUrisSql,
  findRemoteFollow as findRemoteFollowSql,
  listAcceptedRemoteFollowerInboxes as listAcceptedRemoteFollowerInboxesSql,
  listAcceptedRemoteFollowerUris as listAcceptedRemoteFollowerUrisSql,
  listPeerDomains as listPeerDomainsSql,
  listPendingRemoteFollowRequesters as listPendingRemoteFollowRequestersSql,
  rejectRemoteFollowRequest as rejectRemoteFollowRequestSql,
  searchRemoteActors as searchRemoteActorsSql,
  upsertRemoteActor as upsertRemoteActorSql,
  upsertRemoteFollow as upsertRemoteFollowSql,
} from "./generated/prisma/sql";

export type RemoteActorRow = z.infer<typeof RemoteActorRowSchema>;

const parseRemoteActorRow = schemaResult(RemoteActorRowSchema);

const remoteActorFromRow = (row: RemoteActorRow): Result<RemoteActor, RepositoryError> => {
  const fetchedAt = IsoInstant.parse(row.fetched_at);
  if (fetchedAt.isErr()) {
    return err(toRepositoryError("invalid remote actor row"));
  }
  return RemoteActor.fromFetched({
    actorUri: row.actor_uri,
    username: row.username,
    domain: row.domain,
    inboxUri: row.inbox_uri,
    publicKeyId: row.public_key_id,
    publicKeyPem: row.public_key_pem,
    displayName: row.display_name,
    fetchedAt: fetchedAt.value,
    ...(row.shared_inbox_uri ? { sharedInboxUri: row.shared_inbox_uri } : {}),
  }).mapErr(() => toRepositoryError("invalid remote actor row"));
};

const readRemoteActor = async (
  queried: Result<unknown, RepositoryError>,
): Promise<Result<RemoteActor | undefined, RepositoryError>> => {
  if (queried.isErr()) {
    return err(queried.error);
  }
  if (!queried.value) {
    return ok(undefined);
  }
  const row = parseRemoteActorRow(queried.value);
  if (row.isErr()) {
    return err(toRepositoryError("invalid remote actor row"));
  }
  return remoteActorFromRow(row.value);
};

/** A cached actor by its `user@domain` handle, compared without case. */
export const findRemoteActorByHandle = async (
  db: D1Database,
  username: string,
  domain: string,
): Promise<Result<RemoteActor | undefined, RepositoryError>> =>
  readRemoteActor(
    await runD1(async () => {
      const rows = await queryTyped(db, findRemoteActorByHandleSql(username, domain));
      return rows[0];
    }),
  );

export const findRemoteActorByUri = async (
  db: D1Database,
  actorUri: string,
): Promise<Result<RemoteActor | undefined, RepositoryError>> =>
  readRemoteActor(
    await runD1(async () => {
      const rows = await queryTyped(db, findRemoteActorByUriSql(actorUri));
      return rows[0];
    }),
  );

/** Cached remote actors keyed by actor URI; unknown or unreadable rows are left out. */
export const findRemoteActorsByUris = async (
  db: D1Database,
  actorUris: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, RemoteActor>, RepositoryError>> => {
  const unique = [...new Set(actorUris.filter((uri) => uri.length > 0))];
  const actors = new Map<string, RemoteActor>();
  if (unique.length === 0) {
    return ok(actors);
  }
  const queried = await runD1(async () =>
    queryTyped(db, findRemoteActorsByUrisSql(jsonStringArray(unique))),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  for (const raw of queried.value) {
    const row = parseRemoteActorRow(raw);
    const actor = row.isOk() ? remoteActorFromRow(row.value) : undefined;
    if (actor?.isOk()) {
      actors.set(actor.value.actorUri, actor.value);
    }
  }
  return ok(actors);
};

export const findRemoteActorByPublicKeyId = async (
  db: D1Database,
  publicKeyId: string,
): Promise<Result<RemoteActor | undefined, RepositoryError>> =>
  readRemoteActor(
    await runD1(async () => {
      const rows = await queryTyped(db, findRemoteActorByPublicKeyIdSql(publicKeyId));
      return rows[0];
    }),
  );

export const upsertRemoteActor = async (
  db: D1Database,
  actor: RemoteActor,
): Promise<Result<RemoteActor, RepositoryError>> => {
  const written = await runD1(async () => {
    const now = nowIso();
    await runTyped(
      db,
      upsertRemoteActorSql(
        actor.actorUri,
        actor.username,
        actor.domain,
        actor.inboxUri,
        actor.sharedInboxUri ?? null,
        actor.publicKeyId,
        actor.publicKeyPem,
        actor.displayName,
        actor.fetchedAt,
        now,
        now,
      ),
    );
    return actor;
  });
  if (written.isErr()) {
    return err(written.error);
  }
  return ok(written.value);
};

export const upsertRemoteFollow = async (
  db: D1Database,
  remoteActorUri: string,
  targetAccountId: string,
  targetLocked: boolean,
  followActivityId: string | null,
): Promise<Result<void, RepositoryError>> => {
  const state = FollowRequest.initial("RemoteFollower", targetLocked);
  if (state.kind !== "RemoteFollower") {
    return err(toRepositoryError("expected remote follower"));
  }
  return runD1(async () => {
    await runTyped(
      db,
      upsertRemoteFollowSql(
        newEntityId(),
        remoteActorUri,
        targetAccountId,
        state.remoteRequest.kind,
        state.follow.kind,
        followActivityId,
        nowIso(),
      ),
    );
  });
};

export type PendingRemoteFollowRequester = Readonly<{
  remoteActorUri: string;
  createdAt: string;
}>;

export const listPendingRemoteFollowRequesters = async (
  db: D1Database,
  targetAccountId: string,
  limit: number,
): Promise<Result<PendingRemoteFollowRequester[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ remote_actor_uri: string; created_at: string }>(
      db,
      listPendingRemoteFollowRequestersSql(targetAccountId, limit),
    );
    return rows.map((row) => ({
      remoteActorUri: row.remote_actor_uri,
      createdAt: row.created_at,
    }));
  });

/** The original Follow activity id of a pending remote follow, if one exists. */
export const findPendingRemoteFollowRequest = async (
  db: D1Database,
  targetAccountId: string,
  remoteActorUri: string,
): Promise<Result<string | null, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ follow_activity_id: string | null }>(
      db,
      findPendingRemoteFollowRequestSql(targetAccountId, remoteActorUri),
    );
    return rows[0]?.follow_activity_id ?? null;
  });

/** Any remote follow of a local account, pending or accepted. */
export const findRemoteFollow = async (
  db: D1Database,
  targetAccountId: string,
  remoteActorUri: string,
): Promise<
  Result<
    Readonly<{ followActivityId: string | null; requestKind: string }> | undefined,
    RepositoryError
  >
> =>
  runD1(async () => {
    const rows = await queryTyped<{
      follow_activity_id: string | null;
      remote_request_kind: string;
    }>(db, findRemoteFollowSql(targetAccountId, remoteActorUri));
    const row = rows[0];
    return row
      ? { followActivityId: row.follow_activity_id, requestKind: row.remote_request_kind }
      : undefined;
  });

/** Promote a `Queued` remote follow to `Accepted`. Returns true when a row moved. */
export const authorizeRemoteFollowRequest = async (
  db: D1Database,
  targetAccountId: string,
  remoteActorUri: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ remote_actor_uri: string }>(
      db,
      authorizeRemoteFollowRequestSql(targetAccountId, remoteActorUri),
    );
    return rows.length > 0;
  });

/** Remove a `Queued` remote follow. Returns true when a row was deleted. */
export const rejectRemoteFollowRequest = async (
  db: D1Database,
  targetAccountId: string,
  remoteActorUri: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ remote_actor_uri: string }>(
      db,
      rejectRemoteFollowRequestSql(targetAccountId, remoteActorUri),
    );
    return rows.length > 0;
  });

export const deleteRemoteFollow = async (
  db: D1Database,
  remoteActorUri: string,
  targetAccountId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteRemoteFollowSql(remoteActorUri, targetAccountId));
  });

export const listAcceptedRemoteFollowerInboxes = async (
  db: D1Database,
  targetAccountId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped<{ inbox_uri: string; shared_inbox_uri: string | null }>(
      db,
      listAcceptedRemoteFollowerInboxesSql(targetAccountId),
    );
    const inboxes = new Set<string>();
    for (const row of results) {
      inboxes.add(row.shared_inbox_uri ?? row.inbox_uri);
    }
    return [...inboxes];
  });

export const listAcceptedRemoteFollowerUris = async (
  db: D1Database,
  targetAccountId: string,
  limit: number,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped<{ remote_actor_uri: string }>(
      db,
      listAcceptedRemoteFollowerUrisSql(targetAccountId, limit),
    );
    return results.map((row) => row.remote_actor_uri);
  });

export const listPeerDomains = async (db: D1Database): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped<{ domain: string }>(db, listPeerDomainsSql());
    return results.map((row) => row.domain);
  });

/** Cached remote actors matching a username or `username@domain` substring. */
export const searchRemoteActors = async (
  db: D1Database,
  query: string,
  limit: number,
): Promise<Result<RemoteActor[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(db, searchRemoteActorsSql(`%${query}%`, limit));
    const actors: RemoteActor[] = [];
    for (const raw of results) {
      const row = parseRemoteActorRow(raw);
      if (row.isErr()) {
        continue;
      }
      const actor = remoteActorFromRow(row.value);
      if (actor.isOk()) {
        actors.push(actor.value);
      }
    }
    return actors;
  });
