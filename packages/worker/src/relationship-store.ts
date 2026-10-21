import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { parseRows, type RepositoryError, runD1, runD1Batch } from "./d1";
import { nowIso } from "./clock";
import { hostnameOf } from "./domain-block-store";
import { RemoteAccountId } from "./remote-account-id";
import { parseJsonColumn } from "./json-column";
import { d1PrepareTyped, runTyped } from "./typed-sql";
import {
  deleteAccountNote as deleteAccountNoteSql,
  findAccountDomainBlock as findAccountDomainBlockSql,
  findAccountNote as findAccountNoteSql,
  findActiveMute as findActiveMuteSql,
  findBlock as findBlockSql,
  findEndorsement as findEndorsementSql,
  findFollowKind as findFollowKindSql,
  upsertAccountNote as upsertAccountNoteSql,
} from "./generated/prisma/sql";

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

export const relationshipFlags = async (
  db: D1Database,
  viewerId: string,
  targetId: string,
): Promise<Result<RelationshipFlags, RepositoryError>> => {
  const targetActorUri = RemoteAccountId.decode(targetId);
  const targetDomain = targetActorUri.isOk() ? hostnameOf(targetActorUri.value) : undefined;
  const batched = await runD1Batch(db, [
    d1PrepareTyped(db, findFollowKindSql(viewerId, targetId)),
    d1PrepareTyped(db, findFollowKindSql(targetId, viewerId)),
    // Blocks and mutes of a remote account are keyed by its actor URI.
    d1PrepareTyped(db, findBlockSql(viewerId, targetActorUri.unwrapOr(targetId))),
    d1PrepareTyped(db, findBlockSql(targetId, viewerId)),
    d1PrepareTyped(db, findActiveMuteSql(viewerId, targetActorUri.unwrapOr(targetId), nowIso())),
    d1PrepareTyped(db, findEndorsementSql(viewerId, targetId)),
    d1PrepareTyped(db, findAccountNoteSql(viewerId, targetId)),
    d1PrepareTyped(db, findAccountDomainBlockSql(viewerId, targetDomain ?? "")),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  const first = <T>(schema: z.ZodType<T>, index: number): T | undefined =>
    parseRows(schema, batched.value[index]?.results)[0];
  const outgoing = first(
    z.object({
      kind: z.string(),
      reblogs: z.number(),
      notify: z.number(),
      languages_json: z.string(),
    }),
    0,
  );
  const incoming = first(z.object({ kind: z.string() }), 1);
  const blocking = (batched.value[2]?.results?.length ?? 0) > 0;
  const blockedBy = (batched.value[3]?.results?.length ?? 0) > 0;
  const mute = first(z.object({ notifications: z.number(), expires_at: z.string().nullable() }), 4);
  const endorsed = (batched.value[5]?.results?.length ?? 0) > 0;
  const note = first(z.object({ note: z.string() }), 6)?.note ?? "";
  const domainBlocking = (batched.value[7]?.results?.length ?? 0) > 0;
  return ok({
    following: outgoing?.kind === "Accepted",
    showingReblogs: outgoing ? outgoing.reblogs !== 0 : true,
    notifying: outgoing ? outgoing.notify !== 0 : false,
    languages: outgoing
      ? parseJsonColumn(z.array(z.string()), outgoing.languages_json).unwrapOr([])
      : [],
    followedBy: incoming?.kind === "Accepted",
    requested: outgoing?.kind === "Pending",
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
      await runTyped(db, deleteAccountNoteSql(viewerId, target.id));
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
