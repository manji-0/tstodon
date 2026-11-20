import {
  type AccountHandle,
  FollowRequest,
  type Hostname,
  type InboxFollow,
  type InboxFollowRecord,
  IsoInstant,
  RemoteActor,
  RemoteActorKey,
  type RemovedBoost,
  UndoneBeforeArrival,
} from "@tstodon/domain";
import { warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, okValues, parseRows, type RepositoryError, runD1 } from "./d1";
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
  deleteRemoteFollowByActivity as deleteRemoteFollowByActivitySql,
  findPendingRemoteFollowRequest as findPendingRemoteFollowRequestSql,
  claimRemoteActorKeyRefetch as claimRemoteActorKeyRefetchSql,
  claimRemoteActorRefresh as claimRemoteActorRefreshSql,
  findRemoteActorByHandle as findRemoteActorByHandleSql,
  findRemoteActorKey as findRemoteActorKeySql,
  deleteRemoteActorKeysExcept as deleteRemoteActorKeysExceptSql,
  upsertRemoteActorKeys as upsertRemoteActorKeysSql,
  findRemoteActorByUri as findRemoteActorByUriSql,
  listStaleRemoteActorUris as listStaleRemoteActorUrisSql,
  findRemoteActorsByUris as findRemoteActorsByUrisSql,
  findRemoteFollow as findRemoteFollowSql,
  listAcceptedRemoteFollowerInboxes as listAcceptedRemoteFollowerInboxesSql,
  listAccountReachInboxes as listAccountReachInboxesSql,
  listKnownRemoteInboxes as listKnownRemoteInboxesSql,
  listOutboundFollowInboxes as listOutboundFollowInboxesSql,
  listAcceptedRemoteFollowerUris as listAcceptedRemoteFollowerUrisSql,
  listAcceptedRemoteFollowerActors as listAcceptedRemoteFollowerActorsSql,
  listPeerDomains as listPeerDomainsSql,
  searchPeerDomains as searchPeerDomainsSql,
  listPendingRemoteFollowRequesters as listPendingRemoteFollowRequestersSql,
  cancelRemoteActorDeliveries as cancelRemoteActorDeliveriesSql,
  listHomeFanOutAccounts as listHomeFanOutAccountsSql,
  listLocalBoostsOfRemoteActor as listLocalBoostsOfRemoteActorSql,
  listRemoteActorAddressedHomeEntries as listRemoteActorAddressedHomeEntriesSql,
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
  rememberUndoneFollow as rememberUndoneFollowSql,
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
const InboxUriRow = z.object({ inbox_uri: z.string() });

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
const AddressedEntryRow = z.object({ status_id: z.string(), account_id: z.string() });

export const RemoteActorRowSchema = z.object({
  actor_uri: z.string().min(1),
  username: z.string().min(1),
  domain: z.string().min(1),
  inbox_uri: z.string().min(1),
  shared_inbox_uri: z.string().nullable(),
  display_name: z.string(),
  profile_json: z.string().default("{}"),
  moved_to: z.string().nullable().default(null),
  outbox_uri: z.string().nullable().default(null),
  featured_uri: z.string().nullable().default(null),
  featured_tags_uri: z.string().nullable().default(null),
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
    displayName: row.display_name,
    profile: profileFromJson(row.profile_json),
    fetchedAt: fetchedAt.value,
    webfingeredAt: webfingeredAt?.unwrapOr(undefined),
    ...(row.shared_inbox_uri ? { sharedInboxUri: row.shared_inbox_uri } : {}),
    ...(row.moved_to ? { movedTo: row.moved_to } : {}),
    ...(row.outbox_uri ? { outboxUri: row.outbox_uri } : {}),
    ...(row.featured_uri ? { featuredUri: row.featured_uri } : {}),
    ...(row.featured_tags_uri ? { featuredTagsUri: row.featured_tags_uri } : {}),
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

/**
 * How long after one key refetch (a signature that failed against the cached
 * key, `resolveRemoteActor`) the same actor's key may be fetched again.
 */
export const KEY_REFETCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Mark `actorUri`'s key refetched now unless it was in the last
 * {@link KEY_REFETCH_INTERVAL_MS}. One UPDATE decides, so concurrent failed
 * verifications refetch it once. Resolves to whether this call took it; an
 * actor not cached resolves to false.
 */
export const claimRemoteActorKeyRefetch = async (
  db: D1Database,
  actorUri: string,
  now: Date = new Date(),
): Promise<Result<boolean, RepositoryError>> =>
  (
    await runD1(async () =>
      queryTyped(
        db,
        claimRemoteActorKeyRefetchSql(
          actorUri,
          new Date(now.getTime() - KEY_REFETCH_INTERVAL_MS).toISOString(),
          now.toISOString(),
        ),
        ActorUriRow,
      ),
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

/**
 * What `remote_actors.public_key_pem` holds since migration 0152, which moved
 * keys to `remote_actor_keys`: an RSA key whose private half was thrown away.
 * A build from before 0152 (during a deploy, or after a rollback) still parses
 * it, fails to verify any signature with it, and fetches the actor again.
 * The migration writes the same key.
 */
export const LEGACY_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlDmOZr4ifqj8GjQ//kop
6SpR+VT6yWUsAJ/rmi4ePhoOsjCQ1aCpeNm7wr2fq1ZeU6rLnfbACKrGL8WTGNmX
7KuVNnIwJqgrvmfRm7MMAVkLt0QLMoqKwWQZGGNitKhRftoeGpRwPhVHOG0xca8E
rh8ASUo1oZTCLa7wSdrwEH4RbRZzQo6FLpJIM+g0VuBsQtYlEZQAKBN5w5UP0WMB
r9AUBKcxPM4rlch+u2nUB8Nxr3VXQeXvkCIB/lwcw6lh0pbueE1WT/6EHXhRIXSp
ymhLcTzfEN/4GR3viA2r6SAt1PkhhnHH/K04XiZvmHwLt6aFzvZqyEUrc/riWwmd
6QIDAQAB
-----END PUBLIC KEY-----
`;

/** A key and the cached actor that publishes it. */
export type RemoteKeyOwner = Readonly<{ actor: RemoteActor; key: RemoteActorKey }>;

/** Mastodon's `keypairs.type` for each kind of key. */
const KEY_TYPES = { Rsa: "rsa", Ed25519: "ed25519" } as const satisfies Record<
  RemoteActorKey["kind"],
  string
>;

const KeyOwnerRowSchema = RemoteActorRowSchema.extend({
  key_id: z.string().min(1),
  type: z.literal(["rsa", "ed25519"]),
  public_key_pem: z.string().min(1),
});

const keyFromRow = (
  row: z.infer<typeof KeyOwnerRowSchema>,
): Result<RemoteActorKey, RepositoryError> =>
  RemoteActorKey.parse({
    kind: row.type === "rsa" ? "Rsa" : "Ed25519",
    keyId: row.key_id,
    publicKeyPem: row.public_key_pem,
  }).mapErr(() => toRepositoryError("invalid remote actor key row"));

/** The cached key `keyId` names, with the actor that publishes it (Mastodon's `Keypair.from_keyid`). */
export const findRemoteActorKey = async (
  db: D1Database,
  keyId: string,
): Promise<Result<RemoteKeyOwner | undefined, RepositoryError>> => {
  const queried = await runD1(async () => {
    const rows = await queryTyped(db, findRemoteActorKeySql(keyId), KeyOwnerRowSchema);
    return rows[0];
  });
  if (queried.isErr()) {
    return err(queried.error);
  }
  const row = queried.value;
  if (row === undefined) {
    return ok(undefined);
  }
  const actor = remoteActorFromRow(row);
  if (actor.isErr()) {
    return err(actor.error);
  }
  return keyFromRow(row).map((key) => ({ actor: actor.value, key }));
};

/**
 * The statements that make `keys` the keys `actorUri` publishes, as
 * Mastodon's `set_fetchable_key!`: each is stored, unless another actor
 * holds its id, and the actor's others are dropped. They run after the
 * actor's own row is written, in the same batch.
 */
const replaceRemoteActorKeysStatements = (
  actorUri: string,
  keys: ReadonlyArray<RemoteActorKey>,
) => {
  const json = JSON.stringify(
    keys.map((key) => ({
      keyId: key.keyId,
      type: KEY_TYPES[key.kind],
      publicKeyPem: key.publicKeyPem,
    })),
  );
  return [deleteRemoteActorKeysExceptSql(actorUri, json), upsertRemoteActorKeysSql(actorUri, json)];
};

const upsertRemoteActorStatement = (actor: RemoteActor) => {
  const now = nowIso();
  return upsertRemoteActorSql(
    actor.actorUri,
    actor.username,
    actor.domain,
    actor.inboxUri,
    actor.sharedInboxUri ?? null,
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
    actor.featuredTagsUri ?? null,
    LEGACY_PUBLIC_KEY_PEM,
  );
};

/** Cache `actor` under the handle it carries, with `keys` as the keys it publishes. */
export const upsertRemoteActor = async (
  db: D1Database,
  actor: RemoteActor,
  keys: ReadonlyArray<RemoteActorKey>,
): Promise<Result<RemoteActor, RepositoryError>> =>
  (
    await runTypedBatch(db, [
      upsertRemoteActorStatement(actor),
      ...replaceRemoteActorKeysStatements(actor.actorUri, keys),
    ])
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
  keys: ReadonlyArray<RemoteActorKey>,
): Promise<Result<RemoteActor, RepositoryError>> => {
  const now = nowIso();
  const written = await runTypedBatch(db, [
    upsertRemoteActorKeepingHandleSql(
      actor.actorUri,
      actor.username,
      actor.domain,
      actor.inboxUri,
      actor.sharedInboxUri ?? null,
      actor.displayName,
      actor.fetchedAt,
      now,
      now,
      JSON.stringify(actor.profile),
      actor.outboxUri ?? null,
      actor.featuredUri ?? null,
      actor.followersUri ?? null,
      actor.followingUri ?? null,
      actor.featuredTagsUri ?? null,
      LEGACY_PUBLIC_KEY_PEM,
    ),
    ...replaceRemoteActorKeysStatements(actor.actorUri, keys),
  ]);
  if (written.isErr()) {
    return err(written.error);
  }
  const row = parseRows(HandleRow, written.value[0]?.results ?? [])[0];
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
  keys: ReadonlyArray<RemoteActorKey>,
): Promise<Result<RemoteActor, RepositoryError>> =>
  (
    await runTypedBatch(db, [
      demoteRemoteActorHandleSql(actor.username, actor.domain, actor.actorUri),
      upsertRemoteActorStatement(actor),
      ...replaceRemoteActorKeysStatements(actor.actorUri, keys),
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
  nowMs: number = Date.now(),
): Promise<Result<InboxFollowRecord, RepositoryError>> => {
  const state = FollowRequest.initial("RemoteFollower", follow.targetLocked);
  if (state.kind !== "RemoteFollower") {
    return err(toRepositoryError("expected remote follower"));
  }
  return runD1(async (): Promise<InboxFollowRecord> => {
    const recorded = await queryTyped(
      db,
      upsertRemoteFollowSql(
        newEntityId(),
        follow.actorUri,
        follow.targetAccountId,
        state.remoteRequest.kind,
        state.follow.kind,
        follow.followActivityId,
        new Date(nowMs).toISOString(),
        UndoneBeforeArrival.forgottenBefore(nowMs),
      ),
      IdRow,
    );
    return recorded.length > 0 ? "Recorded" : "UndoneFirst";
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

/**
 * Promote a `Queued` remote follow to `Accepted`, dated now: the follower
 * counts from the acceptance, as Mastodon creates the Follow then. Returns
 * true when a row moved.
 */
export const authorizeRemoteFollowRequest = async (
  db: D1Database,
  targetAccountId: string,
  remoteActorUri: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      authorizeRemoteFollowRequestSql(targetAccountId, remoteActorUri, nowIso()),
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

/** End `remoteActorUri`'s follow, or follow request, made by the `Follow` `followActivityId`. */
export const deleteRemoteFollowByActivity = async (
  db: D1Database,
  remoteActorUri: string,
  followActivityId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteRemoteFollowByActivitySql(remoteActorUri, followActivityId));
  });

/**
 * End `remoteActorUri`'s follow of `targetAccountId` for its `Undo` of the
 * `Follow` `followActivityId`. When there is no follow to end, the `Undo` is
 * remembered, so that `Follow` is dropped if it comes after
 * (`upsertRemoteFollow`). One batch, so a `Follow` recorded at the same time
 * is either ended or dropped.
 */
export const undoRemoteFollow = async (
  db: D1Database,
  remoteActorUri: string,
  targetAccountId: string,
  followActivityId: string,
): Promise<Result<void, RepositoryError>> =>
  (
    await runTypedBatch(db, [
      rememberUndoneFollowSql(remoteActorUri, followActivityId, targetAccountId, nowIso()),
      deleteRemoteFollowSql(remoteActorUri, targetAccountId),
    ])
  ).map(() => undefined);

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

/**
 * {@link listAcceptedRemoteFollowerInboxes} of several accounts in one
 * query (a JSON array of ids, so no bound-parameter limit), each inbox once.
 */
export const listAcceptedRemoteFollowerInboxesOf = async (
  db: D1Database,
  targetAccountIds: ReadonlyArray<string>,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare(
        `SELECT DISTINCT a.inbox_uri, a.shared_inbox_uri
         FROM remote_follows f
         JOIN remote_actors a ON a.actor_uri = f.remote_actor_uri
         WHERE f.target_account_id IN (SELECT value FROM json_each(?))
           AND f.follow_kind = 'Accepted'
           AND f.remote_actor_uri NOT IN
             (SELECT actor_uri FROM remote_actor_moderation WHERE moderation = 'Suspended')`,
      )
      .bind(jsonStringArray(targetAccountIds))
      .all();
    return [
      ...new Set(
        parseRows(InboxUriSharedInboxUriRow, rows.results).map(
          (row) => row.shared_inbox_uri ?? row.inbox_uri,
        ),
      ),
    ];
  });

/** How far back Mastodon's `AccountReachFinder` looks for mentions and follows. */
const ACCOUNT_REACH_SINCE_MS = 2 * 24 * 60 * 60 * 1000;
/** The most inboxes {@link listAccountReachInboxes} answers, Mastodon's `RECENT_LIMIT`. */
const ACCOUNT_REACH_LIMIT = 2000;

/**
 * The inboxes beyond its followers' that may hold a copy of a local account
 * (Mastodon's `AccountReachFinder`): its remote reporters, and the actors it
 * mentioned, followed or asked to follow in the last two days.
 */
export const listAccountReachInboxes = async (
  db: D1Database,
  accountId: string,
  now: number = Date.now(),
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const since = new Date(now - ACCOUNT_REACH_SINCE_MS).toISOString();
    const results = await queryTyped(
      db,
      listAccountReachInboxesSql(accountId, since, ACCOUNT_REACH_LIMIT),
      InboxUriRow,
    );
    return results.map((row) => row.inbox_uri);
  });

/** The inboxes of the remote actors `accountId` follows or asked to follow. */
export const listOutboundFollowInboxes = async (
  db: D1Database,
  accountId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(
      db,
      listOutboundFollowInboxesSql(accountId),
      InboxUriSharedInboxUriRow,
    );
    return [...new Set(results.map((row) => row.shared_inbox_uri ?? row.inbox_uri))];
  });

/**
 * Up to `limit` inboxes of the remote actors this server knows, one per
 * shared inbox, those of the most recently fetched actors first (Mastodon's
 * `Account.inboxes`). It reads every cached actor once.
 */
export const listKnownRemoteInboxes = async (
  db: D1Database,
  limit: number,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listKnownRemoteInboxesSql(limit), InboxUriRow);
    return rows.map((row) => row.inbox_uri);
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
 * Known peer hostnames that start with `prefix`, leaving out domains the
 * instance blocks: Mastodon's `Instance.searchable.domain_starts_with`.
 */
export const searchPeerDomains = async (
  db: D1Database,
  prefix: string,
  limit: number,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(db, searchPeerDomainsSql(prefix, limit), DomainRow);
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
        query,
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

/**
 * Home timeline entries a purge of the actor takes away from every follower,
 * newest first, up to `limit`: its public, unlisted and followers-only notes
 * and its boosts. Its limited and direct notes are on the home of the
 * followers they address only ({@link listRemoteActorAddressedHomeEntries}).
 */
export const listRemoteActorHomeEntryIds = async (
  db: D1Database,
  actorUri: string,
  limit: number,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listRemoteActorHomeEntryIdsSql(actorUri, limit), IdRow);
    return rows.map((row) => row.id);
  });

/**
 * The actor's `limit` newest limited and direct notes, each with the accepted
 * local followers it addresses: the homes that hold it, as
 * `listFollowedRemoteStatuses` puts it there.
 */
export const listRemoteActorAddressedHomeEntries = async (
  db: D1Database,
  actorUri: string,
  limit: number,
): Promise<
  Result<ReadonlyArray<Readonly<{ statusId: string; accountIds: string[] }>>, RepositoryError>
> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      listRemoteActorAddressedHomeEntriesSql(actorUri, limit),
      AddressedEntryRow,
    );
    const entries = new Map<string, string[]>();
    for (const row of rows) {
      entries.set(row.status_id, [...(entries.get(row.status_id) ?? []), row.account_id]);
    }
    return [...entries].map(([statusId, accountIds]) => ({ statusId, accountIds }));
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
        // No entry: no hashtag followers.
        listHomeFanOutAccountsSql("", actorUri, ids.at(-1) ?? "", size, ""),
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
warmSchemas([RemoteActorRowSchema, KeyOwnerRowSchema]);
