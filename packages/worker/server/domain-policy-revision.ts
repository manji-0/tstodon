import type { Result } from "neverthrow";
import { z } from "zod";
import { parseRows, type RepositoryError, runD1 } from "./d1";
import { findDomainPolicyRevision as findDomainPolicyRevisionSql } from "./generated/prisma/sql";
import { d1PrepareTyped, type TypedSqlLike } from "./typed-sql";

const RevisionRow = z.object({ token: z.string() });

/**
 * One isolate's copy of a list read from `domain_blocks` or `domain_allows`,
 * with the revision token it was read at.
 */
export type DomainPolicyCopy<T> = { held: Readonly<{ token: string; value: T }> | undefined };

export const domainPolicyCopy = <T>(): DomainPolicyCopy<T> => ({ held: undefined });

const revisionToken = (results: ReadonlyArray<unknown> | undefined): string | undefined =>
  parseRows(RevisionRow, results)[0]?.token;

/**
 * The rows of `list` built into a value, from `copy` while it is current.
 *
 * Every write to `domain_blocks` or `domain_allows` gives
 * `domain_policy_revision` a fresh random token in the same statement
 * (migration 0134's triggers), so a copy is current exactly when the stored
 * token still equals the one it was read with; a rolled-back write restores
 * the old token together with the old rows. A request then reads one row
 * instead of the list. The token and the list are read in one batch, so they
 * come from the same state. Only settled values are kept, never a read in
 * flight (see ip-access.ts).
 */
export const readDomainPolicy = async <T>(
  db: D1Database,
  copy: DomainPolicyCopy<T>,
  list: TypedSqlLike,
  build: (rows: ReadonlyArray<unknown>) => T,
): Promise<Result<T, RepositoryError>> =>
  runD1(async () => {
    const held = copy.held;
    if (held) {
      const { results } = await d1PrepareTyped(db, findDomainPolicyRevisionSql()).all();
      if (revisionToken(results) === held.token) {
        return held.value;
      }
    }
    const [revision, rows] = await db.batch([
      d1PrepareTyped(db, findDomainPolicyRevisionSql()),
      d1PrepareTyped(db, list),
    ]);
    const value = build(rows?.results ?? []);
    const token = revisionToken(revision?.results);
    copy.held = token === undefined ? undefined : { token, value };
    return value;
  });
