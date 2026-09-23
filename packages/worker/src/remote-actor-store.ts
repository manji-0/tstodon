import { FollowRequest, IsoInstant, RemoteActor } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { RemoteActorRowSchema, toRepositoryError } from "./schemas";
import { queryTyped, runTyped } from "./typed-sql";
import {
  deleteRemoteFollow as deleteRemoteFollowSql,
  findRemoteActorByPublicKeyId as findRemoteActorByPublicKeyIdSql,
  findRemoteActorByUri as findRemoteActorByUriSql,
  listAcceptedRemoteFollowerInboxes as listAcceptedRemoteFollowerInboxesSql,
  listAcceptedRemoteFollowerUris as listAcceptedRemoteFollowerUrisSql,
  listPeerDomains as listPeerDomainsSql,
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
        nowIso(),
      ),
    );
  });
};

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
