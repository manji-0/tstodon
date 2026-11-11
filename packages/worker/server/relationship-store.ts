import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, parseRows, type RepositoryError, runD1, runD1Batch } from "./d1";
import { nowIso } from "./clock";
import { OutboundFollow } from "@tstodon/domain";
import { RemoteAccountId } from "./remote-account-id";
import { outboundFollowFromRow } from "./outbound-follow-store";
import { parseJsonColumn } from "./json-column";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import {
  deleteAccountNote as deleteAccountNoteSql,
  findAccountNote as findAccountNoteSql,
  findAccountNotesOfTargetsJson as findAccountNotesOfTargetsJsonSql,
  findActiveMutesOfTargetsJson as findActiveMutesOfTargetsJsonSql,
  findActorDomainBlocksJson as findActorDomainBlocksJsonSql,
  findBlockersOfTargetJson as findBlockersOfTargetJsonSql,
  findBlocksOfTargetsJson as findBlocksOfTargetsJsonSql,
  findEndorsementsOfTargetsJson as findEndorsementsOfTargetsJsonSql,
  findFollowKindsFromFollowersJson as findFollowKindsFromFollowersJsonSql,
  findFollowKindsToTargetsJson as findFollowKindsToTargetsJsonSql,
  findOutboundFollowsJson as findOutboundFollowsJsonSql,
  findRemoteBlocksOfAccountJson as findRemoteBlocksOfAccountJsonSql,
  findRemoteFollowsJson as findRemoteFollowsJsonSql,
  upsertAccountNote as upsertAccountNoteSql,
} from "./generated/prisma/sql";

const NoteRow = z.object({ note: z.string() });

export type RelationshipFlags = Readonly<{
  following: boolean;
  followedBy: boolean;
  requested: boolean;
  /** The target asked to follow the viewer and waits for an answer. */
  requestedBy: boolean;
  blocking: boolean;
  blockedBy: boolean;
  muting: boolean;
  mutingNotifications: boolean;
  mutingExpiresAt: string | null;
  endorsed: boolean;
  note: string;
  domainBlocking: boolean;
  /** The viewer's follow options (absent while not following). */
  showingReblogs: boolean;
  notifying: boolean;
  languages: ReadonlyArray<string>;
}>;

/** The viewer's follow of a remote actor, in the shape of a local follow's flags. */
const remoteOutgoing = (follow: OutboundFollow | undefined) =>
  follow
    ? {
        ...OutboundFollow.relationship(follow),
        reblogs: follow.reblogs,
        notify: follow.notify,
        languages: follow.languages,
      }
    : undefined;

const FollowRow = z.object({
  target_account_id: z.string(),
  kind: z.string(),
  reblogs: z.number(),
  notify: z.number(),
  languages_json: z.string(),
});
const FollowerKindRow = z.object({ follower_account_id: z.string(), kind: z.string() });
const BlockerRow = z.object({ blocker_account_id: z.string() });
const TargetRow = z.object({
  target_account_id: z.string().nullable(),
  target_actor_uri: z.string(),
});
const MuteRow = TargetRow.extend({
  notifications: z.number(),
  expires_at: z.string().nullable(),
});
const TargetNoteRow = TargetRow.extend({ note: z.string() });
const ActorUriRow = z.object({ actor_uri: z.string() });
const RemoteFollowRow = z.object({
  remote_actor_uri: z.string(),
  remote_request_kind: z.literal(["Queued", "Fulfilled"]),
});

/**
 * Rows matched by `target_account_id` or `target_actor_uri`, keyed by both
 * columns, as the single-target lookups match a row by either; the first row wins.
 */
const byTarget = <T extends z.infer<typeof TargetRow>>(rows: ReadonlyArray<T>): Map<string, T> => {
  const keyed = new Map<string, T>();
  for (const row of rows) {
    for (const key of [row.target_account_id, row.target_actor_uri]) {
      if (key !== null && !keyed.has(key)) {
        keyed.set(key, row);
      }
    }
  }
  return keyed;
};

/**
 * The keys a target's rows are stored under: blocks, mutes and notes of a
 * remote account by its actor URI (`uriOrId`), remote-only tables by the URI
 * alone (`""` for a local id).
 */
const targetKeys = (targetId: string) => {
  const actorUri = RemoteAccountId.decode(targetId);
  return { uriOrId: actorUri.unwrapOr(targetId), uri: actorUri.unwrapOr("") };
};

/**
 * Loads the viewer's relationship to every one of `targetIds` (local ids or
 * `r_` remote ids) in one batch: each lookup is one statement for all targets.
 * The answer reads the flags of any of those targets.
 */
export const relationshipFlagsOf = async (
  db: D1Database,
  viewerId: string,
  targetIds: ReadonlyArray<string>,
): Promise<Result<(targetId: string) => RelationshipFlags, RepositoryError>> => {
  const targets = targetIds.map(targetKeys);
  const distinct = (values: ReadonlyArray<string>) => jsonStringArray([...new Set(values)]);
  const ids = distinct(targetIds);
  const urisOrIds = distinct(targets.map((target) => target.uriOrId));
  const uris = distinct(targets.map((target) => target.uri));
  const batched = await runD1Batch(db, [
    d1PrepareTyped(db, findFollowKindsToTargetsJsonSql(viewerId, ids)),
    d1PrepareTyped(db, findFollowKindsFromFollowersJsonSql(ids, viewerId)),
    d1PrepareTyped(db, findBlocksOfTargetsJsonSql(viewerId, urisOrIds)),
    d1PrepareTyped(db, findBlockersOfTargetJsonSql(ids, viewerId)),
    d1PrepareTyped(db, findActiveMutesOfTargetsJsonSql(viewerId, urisOrIds, nowIso())),
    d1PrepareTyped(db, findEndorsementsOfTargetsJsonSql(viewerId, ids)),
    d1PrepareTyped(db, findAccountNotesOfTargetsJsonSql(viewerId, urisOrIds)),
    d1PrepareTyped(db, findActorDomainBlocksJsonSql(viewerId, uris)),
    d1PrepareTyped(db, findOutboundFollowsJsonSql(viewerId, uris)),
    d1PrepareTyped(db, findRemoteBlocksOfAccountJsonSql(uris, viewerId)),
    // A remote target's follow of the viewer: `Queued` waits for an answer
    // (`requested_by`), `Fulfilled` is accepted (`followed_by`).
    d1PrepareTyped(db, findRemoteFollowsJsonSql(viewerId, uris)),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  const rows = <T>(schema: z.ZodType<T>, index: number): T[] =>
    parseRows(schema, batched.value[index]?.results);
  const following = new Map(rows(FollowRow, 0).map((row) => [row.target_account_id, row]));
  const followedBy = new Map(
    rows(FollowerKindRow, 1).map((row) => [row.follower_account_id, row.kind]),
  );
  const blocking = byTarget(rows(TargetRow, 2));
  const blockedBy = new Set(rows(BlockerRow, 3).map((row) => row.blocker_account_id));
  const mutes = byTarget(rows(MuteRow, 4));
  const endorsements = byTarget(rows(TargetRow, 5));
  const notes = byTarget(rows(TargetNoteRow, 6));
  const domainBlocked = new Set(rows(ActorUriRow, 7).map((row) => row.actor_uri));
  const outboundFollows = new Map(
    (batched.value[8]?.results ?? []).flatMap((raw): [string, OutboundFollow][] => {
      const follow = outboundFollowFromRow(raw);
      return follow ? [[follow.actorUri, follow]] : [];
    }),
  );
  const remoteBlockedBy = new Set(rows(ActorUriRow, 9).map((row) => row.actor_uri));
  const remoteFollows = new Map(
    rows(RemoteFollowRow, 10).map((row) => [row.remote_actor_uri, row.remote_request_kind]),
  );
  return ok((targetId) => {
    const { uriOrId, uri } = targetKeys(targetId);
    const local = following.get(targetId);
    const outgoing = local
      ? {
          following: local.kind === "Accepted",
          requested: local.kind === "Pending",
          reblogs: local.reblogs !== 0,
          notify: local.notify !== 0,
          languages: parseJsonColumn(z.array(z.string()), local.languages_json).unwrapOr([]),
        }
      : remoteOutgoing(outboundFollows.get(uri));
    const remoteIncoming = remoteFollows.get(uri);
    const incoming =
      followedBy.get(targetId) ??
      (remoteIncoming ? (remoteIncoming === "Queued" ? "Pending" : "Accepted") : undefined);
    const mute = mutes.get(uriOrId);
    return {
      following: outgoing?.following ?? false,
      showingReblogs: outgoing?.reblogs ?? true,
      notifying: outgoing?.notify ?? false,
      languages: outgoing?.languages ?? [],
      followedBy: incoming === "Accepted",
      requested: outgoing?.requested ?? false,
      requestedBy: incoming === "Pending",
      blocking: blocking.has(uriOrId),
      blockedBy: blockedBy.has(targetId) || remoteBlockedBy.has(uri),
      muting: mute !== undefined,
      mutingNotifications: mute ? mute.notifications !== 0 : false,
      mutingExpiresAt: mute?.expires_at ?? null,
      endorsed: endorsements.has(targetId),
      note: notes.get(uriOrId)?.note ?? "",
      domainBlocking: domainBlocked.has(uri),
    };
  });
};

export const relationshipFlags = async (
  db: D1Database,
  viewerId: string,
  targetId: string,
): Promise<Result<RelationshipFlags, RepositoryError>> =>
  (await relationshipFlagsOf(db, viewerId, [targetId])).map((flagsOf) => flagsOf(targetId));

/** The viewer's private note about the account `target` (an actor URI or a local id) names, if any. */
export const findAccountNoteText = async (
  db: D1Database,
  viewerId: string,
  target: string,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findAccountNoteSql(viewerId, target), NoteRow);
    return rows[0]?.note;
  });

/** Set (or, for an empty note, clear) the viewer's private note about a target. */
export const setAccountNote = async (
  db: D1Database,
  viewerId: string,
  target: Readonly<{ accountId: string | null; actorUri: string; id: string }>,
  note: string,
): Promise<Result<void, RepositoryError>> => {
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    const removed = await runD1(async () => {
      await runTyped(db, deleteAccountNoteSql(viewerId, target.accountId ?? target.actorUri));
    });
    if (removed.isErr()) {
      return err(removed.error);
    }
    return ok(undefined);
  }
  return runD1(async () => {
    await runTyped(
      db,
      upsertAccountNoteSql(viewerId, target.accountId, target.actorUri, trimmed, nowIso()),
    );
  });
};
