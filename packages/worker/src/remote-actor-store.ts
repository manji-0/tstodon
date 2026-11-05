import { FollowRequest, IsoInstant, RemoteActor, type RemovedBoost } from "@tstodon/domain";
import { warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, type RepositoryError, runD1 } from "./d1";
import { newEntityId } from "./ids";
import { toRepositoryError } from "./d1";
import { queryTyped, runTyped, runTypedBatch } from "./typed-sql";
import { RemoteAccountId } from "./remote-account-id";
import { removedBoostsFromRows } from "./removed-boost";
import {
  deleteRemoteActor as deleteRemoteActorSql,
  authorizeRemoteFollowRequest as authorizeRemoteFollowRequestSql,
  claimRemoteOutboxBackfill as claimRemoteOutboxBackfillSql,
  releaseRemoteOutboxBackfill as releaseRemoteOutboxBackfillSql,
  deleteRemoteFollow as deleteRemoteFollowSql,
  findPendingRemoteFollowRequest as findPendingRemoteFollowRequestSql,
  findRemoteActorByHandle as findRemoteActorByHandleSql,
  findRemoteActorByPublicKeyId as findRemoteActorByPublicKeyIdSql,
  findRemoteActorByUri as findRemoteActorByUriSql,
  findRemoteActorsByUris as findRemoteActorsByUrisSql,
  findRemoteFollow as findRemoteFollowSql,
  listAcceptedRemoteFollowerInboxes as listAcceptedRemoteFollowerInboxesSql,
  listAcceptedRemoteFollowerUris as listAcceptedRemoteFollowerUrisSql,
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
  fetched_at: z.string().min(1),
});

export type RemoteActorRow = z.infer<typeof RemoteActorRowSchema>;

/** The stored profile; a row from before profiles (`{}`) reads as empty. */
const profileFromJson = (raw: string) =>
  parseJsonColumn(RemoteActor.profileSchema, raw).unwrapOr(RemoteActor.emptyProfile);

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
    profile: profileFromJson(row.profile_json),
    fetchedAt: fetchedAt.value,
    ...(row.shared_inbox_uri ? { sharedInboxUri: row.shared_inbox_uri } : {}),
    ...(row.moved_to ? { movedTo: row.moved_to } : {}),
    ...(row.outbox_uri ? { outboxUri: row.outbox_uri } : {}),
    ...(row.featured_uri ? { featuredUri: row.featured_uri } : {}),
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

/** A cached actor by its `user@domain` handle, compared without case. */
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
    queryTyped(db, findRemoteActorsByUrisSql(jsonStringArray(unique)), RemoteActorRowSchema),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  for (const row of queried.value) {
    const actor = remoteActorFromRow(row);
    if (actor.isOk()) {
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
      const rows = await queryTyped(
        db,
        findRemoteActorByPublicKeyIdSql(publicKeyId),
        RemoteActorRowSchema,
      );
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
        JSON.stringify(actor.profile),
        actor.outboxUri ?? null,
        actor.featuredUri ?? null,
      ),
    );
    return actor;
  });
  if (written.isErr()) {
    return err(written.error);
  }
  return ok(written.value);
};

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
    const results = await queryTyped(
      db,
      listAcceptedRemoteFollowerUrisSql(targetAccountId, limit),
      RemoteActorUriRow,
    );
    return results.map((row) => row.remote_actor_uri);
  });

export const listPeerDomains = async (db: D1Database): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(db, listPeerDomainsSql(), DomainRow);
    return results.map((row) => row.domain);
  });

/** Cached remote actors matching a username or `username@domain` substring. */
export const searchRemoteActors = async (
  db: D1Database,
  query: string,
  limit: number,
): Promise<Result<RemoteActor[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(
      db,
      searchRemoteActorsSql(`%${query}%`, limit),
      RemoteActorRowSchema,
    );
    const actors: RemoteActor[] = [];
    for (const row of results) {
      const actor = remoteActorFromRow(row);
      if (actor.isOk()) {
        actors.push(actor.value);
      }
    }
    return actors;
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
