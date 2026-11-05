import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { parseRows, type RepositoryError, runD1, runD1Batch } from "./d1";
import { nowIso } from "./clock";
import { OutboundFollow } from "@tstodon/domain";
import { RemoteAccountId } from "./remote-account-id";
import { outboundFollowFromRow } from "./outbound-follow-store";
import { parseJsonColumn } from "./json-column";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import {
  deleteAccountNote as deleteAccountNoteSql,
  findActorDomainBlock as findActorDomainBlockSql,
  findAccountNote as findAccountNoteSql,
  findActiveMute as findActiveMuteSql,
  findBlock as findBlockSql,
  findEndorsement as findEndorsementSql,
  findFollowKind as findFollowKindSql,
  findOutboundFollow as findOutboundFollowSql,
  upsertAccountNote as upsertAccountNoteSql,
} from "./generated/prisma/sql";

const NoteRow = z.object({ note: z.string() });

export type RelationshipFlags = Readonly<{
  following: boolean;
  followedBy: boolean;
  requested: boolean;
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

export const relationshipFlags = async (
  db: D1Database,
  viewerId: string,
  targetId: string,
): Promise<Result<RelationshipFlags, RepositoryError>> => {
  const targetActorUri = RemoteAccountId.decode(targetId);
  const batched = await runD1Batch(db, [
    d1PrepareTyped(db, findFollowKindSql(viewerId, targetId)),
    d1PrepareTyped(db, findFollowKindSql(targetId, viewerId)),
    // Blocks, mutes and notes of a remote account are keyed by its actor URI.
    d1PrepareTyped(db, findBlockSql(viewerId, targetActorUri.unwrapOr(targetId))),
    d1PrepareTyped(db, findBlockSql(targetId, viewerId)),
    d1PrepareTyped(db, findActiveMuteSql(viewerId, targetActorUri.unwrapOr(targetId), nowIso())),
    d1PrepareTyped(db, findEndorsementSql(viewerId, targetId)),
    d1PrepareTyped(db, findAccountNoteSql(viewerId, targetActorUri.unwrapOr(targetId))),
    d1PrepareTyped(db, findActorDomainBlockSql(viewerId, targetActorUri.unwrapOr(""))),
    d1PrepareTyped(db, findOutboundFollowSql(viewerId, targetActorUri.unwrapOr(""))),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  const first = <T>(schema: z.ZodType<T>, index: number): T | undefined =>
    parseRows(schema, batched.value[index]?.results)[0];
  const local = first(
    z.object({
      kind: z.string(),
      reblogs: z.number(),
      notify: z.number(),
      languages_json: z.string(),
    }),
    0,
  );
  const outgoing = local
    ? {
        following: local.kind === "Accepted",
        requested: local.kind === "Pending",
        reblogs: local.reblogs !== 0,
        notify: local.notify !== 0,
        languages: parseJsonColumn(z.array(z.string()), local.languages_json).unwrapOr([]),
      }
    : remoteOutgoing(outboundFollowFromRow(batched.value[8]?.results?.[0]));
  const incoming = first(z.object({ kind: z.string() }), 1);
  const blocking = (batched.value[2]?.results?.length ?? 0) > 0;
  const blockedBy = (batched.value[3]?.results?.length ?? 0) > 0;
  const mute = first(z.object({ notifications: z.number(), expires_at: z.string().nullable() }), 4);
  const endorsed = (batched.value[5]?.results?.length ?? 0) > 0;
  const note = first(z.object({ note: z.string() }), 6)?.note ?? "";
  const domainBlocking = (batched.value[7]?.results?.length ?? 0) > 0;
  return ok({
    following: outgoing?.following ?? false,
    showingReblogs: outgoing?.reblogs ?? true,
    notifying: outgoing?.notify ?? false,
    languages: outgoing?.languages ?? [],
    followedBy: incoming?.kind === "Accepted",
    requested: outgoing?.requested ?? false,
    blocking,
    blockedBy,
    muting: mute !== undefined,
    mutingNotifications: mute ? mute.notifications !== 0 : false,
    mutingExpiresAt: mute?.expires_at ?? null,
    endorsed,
    note,
    domainBlocking,
  });
};

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
