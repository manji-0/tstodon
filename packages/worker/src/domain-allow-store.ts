import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { parseRows, runD1, type RepositoryError } from "./d1";
import { idCursorFragment, type IdCursor } from "./id-cursor";
import { newEntityId } from "./ids";

export type DomainAllowRow = Readonly<{
  id: string;
  domain: string;
  createdAt: string;
}>;

const SELECT = "id, domain, created_at";

const DomainAllowDbRow = z.object({ id: z.string(), domain: z.string(), created_at: z.string() });

const IdRow = z.object({ id: z.string() });
const DomainRow = z.object({ domain: z.string() });

const toRow = (row: z.infer<typeof DomainAllowDbRow>): DomainAllowRow => ({
  id: row.id,
  domain: row.domain,
  createdAt: row.created_at,
});

export const listDomainAllows = async (
  db: D1Database,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<ReadonlyArray<DomainAllowRow>, RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(`SELECT ${SELECT} FROM domain_allows ${where} ${order} LIMIT ?`)
      .bind(...binds, limit)
      .all();
    return parseRows(DomainAllowDbRow, results).map(toRow);
  });

export const findDomainAllowById = async (
  db: D1Database,
  id: string,
): Promise<Result<DomainAllowRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(`SELECT ${SELECT} FROM domain_allows WHERE id = ? LIMIT 1`)
      .bind(id)
      .all();
    const row = parseRows(DomainAllowDbRow, results)[0];
    return row ? toRow(row) : undefined;
  });

/**
 * Allow a domain, idempotently: an already allowed domain keeps its row and
 * `created_at`, so a repeated request answers the same document.
 */
export const insertDomainAllow = async (
  db: D1Database,
  domain: string,
): Promise<Result<DomainAllowRow, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `INSERT INTO domain_allows (id, domain, created_at) VALUES (?, ?, ?)
         ON CONFLICT(domain) DO UPDATE SET domain = excluded.domain
         RETURNING ${SELECT}`,
      )
      .bind(newEntityId(), domain, nowIso())
      .all();
    const row = parseRows(DomainAllowDbRow, results)[0];
    if (!row) {
      throw new Error("domain allow insert returned no row");
    }
    return toRow(row);
  });

export const deleteDomainAllow = async (
  db: D1Database,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare("DELETE FROM domain_allows WHERE id = ? RETURNING id")
      .bind(id)
      .all();
    return parseRows(IdRow, results).length > 0;
  });

/** Every allowed host, for the federation allow list. */
export const domainAllowHosts = async (
  db: D1Database,
): Promise<Result<ReadonlySet<string>, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db.prepare("SELECT domain FROM domain_allows").all();
    return new Set(parseRows(DomainRow, results).map((row) => row.domain));
  });
