import { FollowRequest, IsoInstant, RemoteActor } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { RemoteActorRowSchema, toRepositoryError } from "./schemas";

export type RemoteActorRow = z.infer<typeof RemoteActorRowSchema>;

const remoteActorSelect = `actor_uri, username, domain, inbox_uri, shared_inbox_uri, public_key_id, public_key_pem, display_name, fetched_at`;

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
  const row = schemaResult(RemoteActorRowSchema)(queried.value);
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
    await runD1(() =>
      db
        .prepare(`SELECT ${remoteActorSelect} FROM remote_actors WHERE actor_uri = ?`)
        .bind(actorUri)
        .first(),
    ),
  );

export const findRemoteActorByPublicKeyId = async (
  db: D1Database,
  publicKeyId: string,
): Promise<Result<RemoteActor | undefined, RepositoryError>> =>
  readRemoteActor(
    await runD1(() =>
      db
        .prepare(`SELECT ${remoteActorSelect} FROM remote_actors WHERE public_key_id = ?`)
        .bind(publicKeyId)
        .first(),
    ),
  );

export const upsertRemoteActor = async (
  db: D1Database,
  actor: RemoteActor,
): Promise<Result<RemoteActor, RepositoryError>> => {
  const written = await runD1(async () => {
    await db
      .prepare(
        `INSERT INTO remote_actors (
           actor_uri, username, domain, inbox_uri, shared_inbox_uri,
           public_key_id, public_key_pem, display_name, fetched_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(actor_uri) DO UPDATE SET
           username = excluded.username,
           domain = excluded.domain,
           inbox_uri = excluded.inbox_uri,
           shared_inbox_uri = excluded.shared_inbox_uri,
           public_key_id = excluded.public_key_id,
           public_key_pem = excluded.public_key_pem,
           display_name = excluded.display_name,
           fetched_at = excluded.fetched_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        actor.actorUri,
        actor.username,
        actor.domain,
        actor.inboxUri,
        actor.sharedInboxUri ?? null,
        actor.publicKeyId,
        actor.publicKeyPem,
        actor.displayName,
        actor.fetchedAt,
        nowIso(),
        nowIso(),
      )
      .run();
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
    await db
      .prepare(
        `INSERT INTO remote_follows (
           id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(remote_actor_uri, target_account_id) DO UPDATE SET
           remote_request_kind = excluded.remote_request_kind,
           follow_kind = excluded.follow_kind`,
      )
      .bind(
        newEntityId(),
        remoteActorUri,
        targetAccountId,
        state.remoteRequest.kind,
        state.follow.kind,
        nowIso(),
      )
      .run();
  });
};

export const deleteRemoteFollow = async (
  db: D1Database,
  remoteActorUri: string,
  targetAccountId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(`DELETE FROM remote_follows WHERE remote_actor_uri = ? AND target_account_id = ?`)
      .bind(remoteActorUri, targetAccountId)
      .run();
  });

export const listAcceptedRemoteFollowerInboxes = async (
  db: D1Database,
  targetAccountId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT a.inbox_uri, a.shared_inbox_uri
         FROM remote_follows f
         JOIN remote_actors a ON a.actor_uri = f.remote_actor_uri
         WHERE f.target_account_id = ? AND f.follow_kind = 'Accepted'`,
      )
      .bind(targetAccountId)
      .all<{ inbox_uri: string; shared_inbox_uri: string | null }>();
    const inboxes = new Set<string>();
    for (const row of results ?? []) {
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
    const { results } = await db
      .prepare(
        `SELECT remote_actor_uri FROM remote_follows
         WHERE target_account_id = ? AND follow_kind = 'Accepted'
         ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(targetAccountId, limit)
      .all<{ remote_actor_uri: string }>();
    return (results ?? []).map((row) => row.remote_actor_uri);
  });

export const listPeerDomains = async (db: D1Database): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT domain FROM remote_actors
         WHERE domain IS NOT NULL AND domain != ''
         ORDER BY domain ASC`,
      )
      .all<{ domain: string }>();
    return (results ?? []).map((row) => row.domain);
  });
