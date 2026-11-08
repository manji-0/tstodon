import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import {
  deleteAnnouncementReaction as deleteAnnouncementReactionSql,
  listAnnouncementDismissals as listAnnouncementDismissalsSql,
  listAnnouncementReactions as listAnnouncementReactionsSql,
  upsertAnnouncementDismissal as upsertAnnouncementDismissalSql,
  upsertAnnouncementReaction as upsertAnnouncementReactionSql,
} from "./generated/prisma/sql";
import { queryTyped, runTyped } from "./typed-sql";

const AnnouncementIdRow = z.object({ announcement_id: z.string() });
const Row2 = z.object({
  announcement_id: z.string(),
  reaction_name: z.string(),
  count: z.union([z.number(), z.bigint()]),
  me: z.union([z.number(), z.bigint()]),
});
const ReactionNameRow = z.object({ reaction_name: z.string() });

export type AnnouncementReactionState = Readonly<{ count: number; me: boolean }>;

export const listAnnouncementDismissals = async (
  db: D1Database,
  accountId: string,
): Promise<Result<ReadonlySet<string>, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listAnnouncementDismissalsSql(accountId), AnnouncementIdRow);
    return new Set(rows.map((row) => row.announcement_id));
  });

export const dismissAnnouncement = async (
  db: D1Database,
  accountId: string,
  announcementId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, upsertAnnouncementDismissalSql(accountId, announcementId, nowIso()));
  });

/** Reaction counts per announcement, with the viewer's own reactions flagged. */
export const announcementReactionState = async (
  db: D1Database,
  accountId: string,
): Promise<
  Result<ReadonlyMap<string, ReadonlyMap<string, AnnouncementReactionState>>, RepositoryError>
> =>
  runD1(async () => {
    const rows = await queryTyped(db, listAnnouncementReactionsSql(accountId), Row2);
    const state = new Map<string, Map<string, AnnouncementReactionState>>();
    for (const row of rows) {
      if (row.announcement_id.length === 0 || row.reaction_name.length === 0) {
        continue;
      }
      let byName = state.get(row.announcement_id);
      if (!byName) {
        byName = new Map<string, AnnouncementReactionState>();
        state.set(row.announcement_id, byName);
      }
      byName.set(row.reaction_name, {
        count: Number(row.count),
        me: Number(row.me) > 0,
      });
    }
    return state;
  });

export const addAnnouncementReaction = async (
  db: D1Database,
  accountId: string,
  announcementId: string,
  reactionName: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      upsertAnnouncementReactionSql(accountId, announcementId, reactionName, nowIso()),
    );
  });

export const removeAnnouncementReaction = async (
  db: D1Database,
  accountId: string,
  announcementId: string,
  reactionName: string,
): Promise<Result<boolean, RepositoryError>> => {
  const deleted = await runD1(async () => {
    const rows = await queryTyped(
      db,
      deleteAnnouncementReactionSql(accountId, announcementId, reactionName),
      ReactionNameRow,
    );
    return rows.length > 0;
  });
  if (deleted.isErr()) {
    return err(deleted.error);
  }
  return ok(deleted.value);
};
