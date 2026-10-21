import type { Result } from "neverthrow";
import { type RepositoryError, runD1 } from "./d1";
import { nowIso } from "./clock";
import { queryTyped, runTyped } from "./typed-sql";
import {
  dismissSuggestion as dismissSuggestionSql,
  listSuggestionExclusionIds as listSuggestionExclusionIdsSql,
} from "./generated/prisma/sql";

/** Account ids the viewer already follows, blocks, has muted, or dismissed (suggestions skip these). */
export const listSuggestionExclusionIds = async (
  db: D1Database,
  viewerId: string,
): Promise<Result<Set<string>, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string | null }>(
      db,
      listSuggestionExclusionIdsSql(viewerId, nowIso()),
    );
    return new Set(rows.flatMap((row) => (row.id ? [row.id] : [])));
  });

/** Remove an account from the viewer's follow suggestions for good. */
export const dismissSuggestion = async (
  db: D1Database,
  viewerId: string,
  targetAccountId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, dismissSuggestionSql(viewerId, targetAccountId, nowIso()));
  });
