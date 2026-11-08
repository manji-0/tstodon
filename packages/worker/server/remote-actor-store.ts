import {
  type AccountHandle,
  FollowRequest,
  type Hostname,
  type InboxFollow,
  IsoInstant,
  RemoteActor,
  type RemovedBoost,
} from "@tstodon/domain";
import { warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, okValues, type RepositoryError, runD1 } from "./d1";
import { newEntityId } from "./ids";
import { toRepositoryError } from "./d1";
import { queryTyped, runTyped, runTypedBatch } from "./typed-sql";
import { RemoteAccountId } from "./remote-account-id";
import { removedBoostsFromRows } from "./removed-boost";
import {
  deleteRemoteActor as deleteRemoteActorSql,
  demoteRemoteActorHandle as demoteRemoteActorHandleSql,
  authorizeRemoteFollowRequest as authorizeRemoteFollowRequestSql,
  claimRemoteOutboxBackfill as claimRemoteOutboxBackfillSql,
  releaseRemoteOutboxBackfill as releaseRemoteOutboxBackfillSql,
  deleteRemoteFollow as deleteRemoteFollowSql,
  findPendingRemoteFollowRequest as findPendingRemoteFollowRequestSql,
  claimRemoteActorRefresh as claimRemoteActorRefreshSql,
  findRemoteActorByHandle as findRemoteActorByHandleSql,
  findRemoteActorByPublicKeyId as findRemoteActorByPublicKeyIdSql,
  findRemoteActorByUri as findRemoteActorByUriSql,
  listStaleRemoteActorUris as listStaleRemoteActorUrisSql,
  findRemoteActorsByUris as findRemoteActorsByUrisSql,
  findRemoteFollow as findRemoteFollowSql,
  listAcceptedRemoteFollowerInboxes as listAcceptedRemoteFollowerInboxesSql,
  listAcceptedRemoteFollowerUris as listAcceptedRemoteFollowerUrisSql,
  listAcceptedRemoteFollowerActors as listAcceptedRemoteFollowerActorsSql,
  listPeerDomains as listPeerDomainsSql,
  listPendingRemoteFollowRequesters as listPendingRemoteFollowRequestersSql,
  cancelRemoteActorDeliveries as cancelRemoteActorDeliveriesSql,
  listHomeFanOutAccounts as listHomeFanOutAccountsSql,
  listLocalBoostsOfRemoteActor as listLocalBoostsOfRemoteActorSql,
  listRemoteActorHomeEntryIds as listRemoteActorHomeEntryIdsSql,
  purgeRemoteActorConversationHides as purgeRemoteActorConversationHidesSql,
  purgeRemoteActorConversationReads as purgeRemoteActorConversationReadsSql,
  purgeRemoteActorStatusMutes as purgeRemoteActorStatusMutesSql,
  purgeRemoteActorBlocks as purgeRemoteActorBlocksSql,
  purgeRemoteActorEndorsements as purgeRemoteActorEndorsementsSql,
  purgeRemoteActorMutes as purgeRemoteActorMutesSql,
  purgeRemoteActorNotes as purgeRemoteActorNotesSql,
  purgeRemoteActorNotificationDismissals as purgeRemoteActorNotificationDismissalsSql,
  purgeRemoteActorNotifications as purgeRemoteActorNotificationsSql,
  purgeRemoteActorRequestAcceptances as purgeRemoteActorRequestAcceptancesSql,
  purgeRemoteActorRequestGroups as purgeRemoteActorRequestGroupsSql,
  rejectRemoteFollowRequest as rejectRemoteFollowRequestSql,
  searchRemoteActors as searchRemoteActorsSql,
  setRemoteActorMovedTo as setRemoteActorMovedToSql,
  upsertRemoteActor as upsertRemoteActorSql,
  upsertRemoteActorKeepingHandle as upsertRemoteActorKeepingHandleSql,
  upsertRemoteFollow as upsertRemoteFollowSql,
} from "./generated/prisma/sql";
import { parseJsonColumn } from "./json-column";

const ActorUriRow = z.object({ actor_uri: z.string() });
const RemoteActorUriCreatedAtRow = z.object({
  remote_actor_uri: z.string(),
  created_at: z.string(),
});
const FollowActivityIdRow = z.object({ follow_activity_id: z.string().nullable() });
const FollowActivityIdRemoteRequestKindRow = z.object({
  follow_activity_id: z.string().nullable(),
  remote_request_kind: z.string(),
});
const RemoteActorUriRow = z.object({ remote_actor_uri: z.string() });
const InboxUriSharedInboxUriRow = z.object({
  inbox_uri: z.string(),
  shared_inbox_uri: z.string().nullable(),
});
const DomainRow = z.object({ domain: z.string() });
const HandleRow = z.object({
  username: z.string(),
  domain: z.string(),
  last_webfingered_at: z.string().nullable(),
});
const IdRow = z.object({ id: z.string() });
const AccountIdRow = z.object({ account_id: z.string() });

export const RemoteActorRowSchema = z.object({
  actor_uri: z.string().min(1),
  username: z.string().min(1),
  domain: z.string().min(1),
  inbox_uri: z.string().min(1),
  shared_inbox_uri: z.string().nullable(),
  public_key_id: z.string().min(1),
  public_key_pem: z.string().min(1),
  display_name: z.string(),
  profile_json: z.string().default("{}"),
  moved_to: z.string().nullable().default(null),
  outbox_uri: z.string().nullable().default(null),
  featured_uri: z.string().nullable().default(null),
  followers_uri: z.string().nullable().default(null),
  following_uri: z.string().nullable().default(null),
  fetched_at: z.string().min(1),
  last_webfingered_at: z.string().nullable().default(null),
});

export type RemoteActorRow = z.infer<typeof RemoteActorRowSchema>;

/** The stored profile; a row from before profiles (`{}`) reads as empty. */
const profileFromJson = (raw: string) =>
  parseJsonColumn(RemoteActor.profileSchema, raw).unwrapOr(RemoteActor.emptyProfile);

const remoteActorFromRow = (row: RemoteActorRow): Result<RemoteActor, RepositoryError> => {
  const fetchedAt = IsoInstant.parse(row.fetched_at);
  const webfingeredAt =
    row.last_webfingered_at === null ? undefined : IsoInstant.parse(row.last_webfingered_at);
  if (fetchedAt.isErr() || webfingeredAt?.isErr()) {
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
    profile: profileFromJson(row.profile_json),
    fetchedAt: fetchedAt.value,
    webfingeredAt: webfingeredAt?.unwrapOr(undefined),
    ...(row.shared_inbox_uri ? { sharedInboxUri: row.shared_inbox_uri } : {}),
    ...(row.moved_to ? { movedTo: row.moved_to } : {}),
    ...(row.outbox_uri ? { outboxUri: row.outbox_uri } : {}),
    ...(row.featured_uri ? { featuredUri: row.featured_uri } : {}),
    ...(row.followers_uri ? { followersUri: row.followers_uri } : {}),
    ...(row.following_uri ? { followingUri: row.following_uri } : {}),
  }).mapErr(() => toRepositoryError("invalid remote actor row"));
};

const readRemoteActor = async (
  queried: Result<RemoteActorRow | undefined, RepositoryError>,
): Promise<Result<RemoteActor | undefined, RepositoryError>> => {
  if (queried.isErr()) {
    return err(queried.error);
  }
  return queried.value === undefined ? ok(undefined) : remoteActorFromRow(queried.value);
};

/**
 * A cached actor by its `user@domain` handle, compared without case. Two rows
 * can share a handle for a while (a row cached before the round trip, or one
 * whose server stopped answering); the one WebFinger confirmed last wins.
 */
export const findRemoteActorByHandle = async (
  db: D1Database,
  username: string,
  domain: string,
): Promise<Result<RemoteActor | undefined, RepositoryError>> =>
  readRemoteActor(
    await runD1(async () => {
      const rows = await queryTyped(
        db,
        findRemoteActorByHandleSql(username, domain),
        RemoteActorRowSchema,
      );
      return rows[0];
    }),
  );

export const findRemoteActorByUri = async (
  db: D1Database,
  actorUri: string,
): Promise<Result<RemoteActor | undefined, RepositoryError>> =>
  readRemoteActor(
    await runD1(async () => {
      const rows = await queryTyped(db, findRemoteActorByUriSql(actorUri), RemoteActorRowSchema);
      return rows[0];
    }),
  );

/**
 * Mastodon's `possibly_stale?` window: an actor is due a refresh once both
 * its last confirmation (its fetch, when WebFinger never confirmed it) and
 * its last refresh attempt are this old.
 */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

const dueBefore = (): string => new Date(Date.now() - REFRESH_AFTER_MS).toISOString();

/** Up to `limit` actor URIs due a refresh, the longest waiting first. */
export const listStaleRemoteActorUris = async (
  db: D1Database,
  limit: number,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  (
    await runD1(async () =>
      queryTyped(db, listStaleRemoteActorUrisSql(dueBefore(), limit), ActorUriRow),
    )
  ).map((rows) => rows.map((row) => row.actor_uri));

/**
 * Mark `actorUri` tried now if it is due a refresh. One UPDATE decides, so
 * concurrent callers refresh it once. Resolves to whether this call took it.
 */
export const claimRemoteActorRefresh = async (
  db: D1Database,
  actorUri: string,
): Promise<Result<boolean, RepositoryError>> =>
  (
    await runD1(async () =>
      queryTyped(db, claimRemoteActorRefreshSql(actorUri, dueBefore(), nowIso()), ActorUriRow),
    )
  ).map((rows) => rows.length > 0);

/** Cached remote actors keyed by actor URI; unknown or unreadable rows are left out. */
export const findRemoteActorsByUris = async (
  db: D1Database,
  actorUris: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, RemoteActor>, RepositoryError>> => {
  const unique = [...new Set(actorUris.filter((uri) => uri.length > 0))];
  if (unique.length === 0) {
    return ok(new Map<string, RemoteActor>());
  }
  const queried = await runD1(async () =>
    queryTyped(db, findRemoteActorsByUrisSql(jsonStringArray(unique)), RemoteActorRowSchema),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(
    new Map(
      okValues(queried.value.map((row) => remoteActorFromRow(row))).map((actor) => [
        actor.actorUri,
        actor,
      ]),
    ),
  );
};

export const findRemoteActorByPublicKeyId = async (
  db: D1Database,
  publicKeyId: string,
): Promise<Result<RemoteActor | undefined, RepositoryError>> =>
  readRemoteActor(
    await runD1(async () => {
      const rows = await queryTyped(
        db,
        findRemoteActorByPublicKeyIdSql(publicKeyId),
        RemoteActorRowSchema,
      );
      return rows[0];
    }),
  );

const upsertRemoteActorStatement = (actor: RemoteActor) => {
  const now = nowIso();
  return upsertRemoteActorSql(
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
    JSON.stringify(actor.profile),
    actor.outboxUri ?? null,
    actor.featuredUri ?? null,
    actor.webfingeredAt ?? null,
    actor.followersUri ?? null,
    actor.followingUri ?? null,
  );
};

export const upsertRemoteActor = async (
  db: D1Database,
  actor: RemoteActor,
): Promise<Result<RemoteActor, RepositoryError>> =>
  (
    await runD1(async () => {
      await runTyped(db, upsertRemoteActorStatement(actor));
    })
  ).map(() => actor);

/**
 * Cache an actor read from its own document without settling its handle: a
 * new row takes the actor's handle (its URI's authority), unconfirmed; a
 * cached row keeps the handle and confirmation time it holds as the write
 * runs. Returns the actor under the handle the row ends up with.
 */
export const upsertRemoteActorKeepingHandle = async (
  db: D1Database,
  actor: RemoteActor,
): Promise<Result<RemoteActor, RepositoryError>> => {
  const now = nowIso();
  const written = await runD1(async () =>
    queryTyped(
      db,
      upsertRemoteActorKeepingHandleSql(
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
        JSON.stringify(actor.profile),
        actor.outboxUri ?? null,
        actor.featuredUri ?? null,
        actor.followersUri ?? null,
        actor.followingUri ?? null,
      ),
      HandleRow,
    ),
  );
  if (written.isErr()) {
    return err(written.error);
  }
  const row = written.value[0];
  const webfingeredAt = row?.last_webfingered_at
    ? IsoInstant.parse(row.last_webfingered_at)
    : undefined;
  if (row === undefined || webfingeredAt?.isErr()) {
    return err(toRepositoryError("invalid remote actor row"));
  }
  return RemoteActor.fromFetched({
    ...actor,
    username: row.username,
    domain: row.domain,
    webfingeredAt: webfingeredAt?.unwrapOr(undefined),
  }).mapErr(() => toRepositoryError("invalid remote actor row"));
};

/**
 * Cache an actor under the handle WebFinger just confirmed for it, and move
 * every other row cached under that handle back to its own URI's authority,
 * in one batch, so the handle names one actor: the one confirmed last.
 */
export const upsertConfirmedRemoteActor = async (
  db: D1Database,
  actor: RemoteActor,
): Promise<Result<RemoteActor, RepositoryError>> =>
  (
    await runTypedBatch(db, [
      demoteRemoteActorHandleSql(actor.username, actor.domain, actor.actorUri),
      upsertRemoteActorStatement(actor),
    ])
  ).map(() => actor);

/**
 * Move every confirmed row cached under `handle` but `keptBy` back to its own
 * URI's authority: the handle's own domain said the handle is `keptBy`'s, or,
 * without `keptBy`, nobody's.
 */
export const releaseRemoteActorHandle = async (
  db: D1Database,
  handle: AccountHandle,
  keptBy: string | undefined,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, demoteRemoteActorHandleSql(handle.username, handle.domain, keptBy ?? ""));
  });

/** Record that `actorUri` moved to `movedTo` (the caller has verified the move), or, with `null`, that it did not. */
export const setRemoteActorMovedTo = async (
  db: D1Database,
  actorUri: string,
  movedTo: string | null,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, setRemoteActorMovedToSql(actorUri, movedTo));
  });

/**
 * Mark `actorUri`'s outbox as being backfilled now, unless it was within
 * `ttlMs`. One UPDATE decides, so concurrent profile views claim it once.
 * Resolves to the claim's timestamp, or undefined when another holds it.
 */
export const claimRemoteOutboxBackfill = async (
  db: D1Database,
  actorUri: string,
  ttlMs: number,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const now = Date.now();
    const claimedAt = new Date(now).toISOString();
    const rows = await queryTyped(
      db,
      claimRemoteOutboxBackfillSql(claimedAt, actorUri, new Date(now - ttlMs).toISOString()),
      ActorUriRow,
    );
    return rows.length > 0 ? claimedAt : undefined;
  });

/** Give up a claim whose job could not be queued, so the next view tries again. */
export const releaseRemoteOutboxBackfill = async (
  db: D1Database,
  actorUri: string,
  claimedAt: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, releaseRemoteOutboxBackfillSql(actorUri, claimedAt));
  });

export const upsertRemoteFollow = async (
  db: D1Database,
  follow: InboxFollow,
): Promise<Result<void, RepositoryError>> => {
  const state = FollowRequest.initial("RemoteFollower", follow.targetLocked);
  if (state.kind !== "RemoteFollower") {
    return err(toRepositoryError("expected remote follower"));
  }
  return runD1(async () => {
    await runTyped(
      db,
      upsertRemoteFollowSql(
        newEntityId(),
        follow.actorUri,
        follow.targetAccountId,
        state.remoteRequest.kind,
        state.follow.kind,
        follow.followActivityId,
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
    const rows = await queryTyped(
      db,
      listPendingRemoteFollowRequestersSql(targetAccountId, limit),
      RemoteActorUriCreatedAtRow,
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
    const rows = await queryTyped(
      db,
      findPendingRemoteFollowRequestSql(targetAccountId, remoteActorUri),
      FollowActivityIdRow,
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
    const rows = await queryTyped(
      db,
      findRemoteFollowSql(targetAccountId, remoteActorUri),
      FollowActivityIdRemoteRequestKindRow,
    );
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
    const rows = await queryTyped(
      db,
      authorizeRemoteFollowRequestSql(targetAccountId, remoteActorUri),
      RemoteActorUriRow,
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
    const rows = await queryTyped(
      db,
      rejectRemoteFollowRequestSql(targetAccountId, remoteActorUri),
      RemoteActorUriRow,
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
    const results = await queryTyped(
      db,
      listAcceptedRemoteFollowerInboxesSql(targetAccountId),
      InboxUriSharedInboxUriRow,
    );
    return [...new Set(results.map((row) => row.shared_inbox_uri ?? row.inbox_uri))];
  });

export const listAcceptedRemoteFollowerUris = async (
  db: D1Database,
  targetAccountId: string,
  limit: number,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(
      db,
      listAcceptedRemoteFollowerUrisSql(targetAccountId, limit),
      RemoteActorUriRow,
    );
    return results.map((row) => row.remote_actor_uri);
  });

/** Which of `actorUris` follow the local account, accepted follows only. */
export const remoteFollowerActorUris = async (
  db: D1Database,
  targetAccountId: string,
  actorUris: ReadonlyArray<string>,
): Promise<Result<ReadonlySet<string>, RepositoryError>> =>
  runD1(async () => {
    if (actorUris.length === 0) {
      return new Set<string>();
    }
    const results = await queryTyped(
      db,
      listAcceptedRemoteFollowerActorsSql(
        targetAccountId,
        jsonStringArray([...new Set(actorUris)]),
      ),
      RemoteActorUriRow,
    );
    return new Set(results.map((row) => row.remote_actor_uri));
  });

export const listPeerDomains = async (db: D1Database): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(db, listPeerDomainsSql(), DomainRow);
    return results.map((row) => row.domain);
  });

/**
 * The federation state that hides a remote actor's domain: the hostnames
 * this instance suspends, and the allow list (empty when there is none).
 */
export type RemoteActorSearchHosts = Readonly<{
  suspended: ReadonlySet<Hostname>;
  allow: ReadonlySet<string>;
}>;

/**
 * Cached remote actors matching a username or `username@domain` substring,
 * newest URI first, leaving out those search may not list (a suspended actor,
 * or a domain `hosts` hides), so `offset` counts listed actors. The query
 * applies the rules `searchableRemoteActors` does.
 */
export const searchRemoteActors = async (
  db: D1Database,
  query: string,
  hosts: RemoteActorSearchHosts,
  limit: number,
  offset: number,
): Promise<Result<RemoteActor[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(
      db,
      searchRemoteActorsSql(
        `%${query}%`,
        jsonStringArray([...hosts.suspended]),
        jsonStringArray([...hosts.allow]),
        limit,
        offset,
      ),
      RemoteActorRowSchema,
    );
    return okValues(results.map((row) => remoteActorFromRow(row)));
  });

/**
 * Forget a remote actor that deleted its account, and everything cached for it.
 *
 * Deleting the `remote_actors` row cascades to its statuses (and their tags and
 * mentions), follows and follow requests both ways, favourites, announces, and the
 * mentions local notes made of it. Rows keyed by actor URI or `r_…` id without
 * a foreign key (notifications, blocks, mutes, endorsements, notes) go in the
 * same batch, as do the thread mutes and conversation marks that point at the
 * actor's statuses, and the queued deliveries to its inbox (marked failed, so a
 * delivery workflow waiting to retry stops at its next attempt; a shared inbox
 * stays while another cached actor uses it). The local boosts of its statuses
 * go with them by cascade and are returned. Resolves to `undefined` when the
 * actor was not cached.
 */
export const purgeRemoteActor = async (
  db: D1Database,
  actorUri: string,
): Promise<
  Result<Readonly<{ boosts: ReadonlyArray<RemovedBoost> }> | undefined, RepositoryError>
> => {
  const remoteAccountId = RemoteAccountId.encode(actorUri);
  const batched = await runTypedBatch(db, [
    listLocalBoostsOfRemoteActorSql(actorUri),
    cancelRemoteActorDeliveriesSql(actorUri, nowIso()),
    purgeRemoteActorStatusMutesSql(actorUri),
    purgeRemoteActorConversationReadsSql(actorUri),
    purgeRemoteActorConversationHidesSql(actorUri),
    purgeRemoteActorNotificationDismissalsSql(actorUri),
    purgeRemoteActorNotificationsSql(actorUri),
    purgeRemoteActorRequestGroupsSql(remoteAccountId),
    purgeRemoteActorRequestAcceptancesSql(remoteAccountId),
    purgeRemoteActorBlocksSql(actorUri),
    purgeRemoteActorMutesSql(actorUri),
    purgeRemoteActorEndorsementsSql(actorUri),
    purgeRemoteActorNotesSql(actorUri),
    deleteRemoteActorSql(actorUri),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  if ((batched.value.at(-1)?.results ?? []).length === 0) {
    return ok(undefined);
  }
  return ok({ boosts: removedBoostsFromRows(batched.value[0]?.results) });
};

/** Home timeline entries a purge of the actor takes away, newest first, up to `limit`. */
export const listRemoteActorHomeEntryIds = async (
  db: D1Database,
  actorUri: string,
  limit: number,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listRemoteActorHomeEntryIdsSql(actorUri, limit), IdRow);
    return rows.map((row) => row.id);
  });

/** Ids of the local accounts that follow the actor, in order, up to `limit`. */
export const listRemoteActorFollowerAccountIds = async (
  db: D1Database,
  actorUri: string,
  limit: number,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const ids: string[] = [];
    while (ids.length < limit) {
      const size = Math.min(200, limit - ids.length);
      const page = await queryTyped(
        db,
        listHomeFanOutAccountsSql("", actorUri, ids.at(-1) ?? "", size),
        AccountIdRow,
      );
      ids.push(...page.map((row) => row.account_id));
      if (page.length < size) {
        break;
      }
    }
    return ids;
  });

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([RemoteActorRowSchema]);
