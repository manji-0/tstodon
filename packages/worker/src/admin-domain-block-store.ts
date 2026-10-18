import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import {
  deleteDomainBlock as deleteDomainBlockSql,
  findDomainBlockByDomain as findDomainBlockByDomainSql,
  findDomainBlockById as findDomainBlockByIdSql,
  insertDomainBlock as insertDomainBlockSql,
  listDomainBlocks as listDomainBlocksSql,
  listRestrictedDomains as listRestrictedDomainsSql,
  listSuspendedDomains as listSuspendedDomainsSql,
  updateDomainBlock as updateDomainBlockSql,
} from "./generated/prisma/sql";
import { newEntityId } from "./ids";
import { queryTyped, runTyped } from "./typed-sql";

export const DomainBlockSeveritySchema = z.union([
  z.literal("silence"),
  z.literal("suspend"),
  z.literal("noop"),
]);

export type DomainBlockSeverity = z.infer<typeof DomainBlockSeveritySchema>;

export const DomainBlockRowSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  severity: DomainBlockSeveritySchema,
  reject_media: z.number(),
  reject_reports: z.number(),
  obfuscate: z.number(),
  private_comment: z.string().nullable(),
  public_comment: z.string().nullable(),
  created_at: z.string(),
});

export type DomainBlockRow = z.infer<typeof DomainBlockRowSchema>;

export type DomainBlockInput = Readonly<{
  domain: string;
  severity: DomainBlockSeverity;
  rejectMedia: boolean;
  rejectReports: boolean;
  obfuscate: boolean;
  privateComment: string | null;
  publicComment: string | null;
}>;

const parseRow = schemaResult(DomainBlockRowSchema);

export const listDomainBlocks = async (
  db: D1Database,
  limit: number,
  maxId: string | null,
): Promise<Result<DomainBlockRow[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listDomainBlocksSql(limit, maxId ?? ""));
    const blocks: DomainBlockRow[] = [];
    for (const raw of rows) {
      const row = parseRow(raw);
      if (row.isOk()) {
        blocks.push(row.value);
      }
    }
    return blocks;
  });

export const findDomainBlockById = async (
  db: D1Database,
  id: string,
): Promise<Result<DomainBlockRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findDomainBlockByIdSql(id));
    const row = parseRow(rows[0]);
    return row.isOk() ? row.value : undefined;
  });

export const findDomainBlockByDomain = async (
  db: D1Database,
  domain: string,
): Promise<Result<DomainBlockRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findDomainBlockByDomainSql(domain));
    const row = parseRow(rows[0]);
    return row.isOk() ? row.value : undefined;
  });

export const insertDomainBlock = async (
  db: D1Database,
  input: DomainBlockInput,
): Promise<Result<string, RepositoryError>> => {
  const id = newEntityId();
  const written = await runD1(async () => {
    await runTyped(
      db,
      insertDomainBlockSql(
        id,
        input.domain,
        input.severity,
        input.rejectMedia ? 1 : 0,
        input.rejectReports ? 1 : 0,
        input.obfuscate ? 1 : 0,
        input.privateComment,
        input.publicComment,
        nowIso(),
      ),
    );
  });
  if (written.isErr()) {
    return err(written.error);
  }
  return ok(id);
};

export const updateDomainBlock = async (
  db: D1Database,
  id: string,
  input: Omit<DomainBlockInput, "domain">,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(
      db,
      updateDomainBlockSql(
        id,
        input.severity,
        input.rejectMedia ? 1 : 0,
        input.rejectReports ? 1 : 0,
        input.obfuscate ? 1 : 0,
        input.privateComment,
        input.publicComment,
        nowIso(),
      ),
    );
    return rows.length > 0;
  });

export const deleteDomainBlock = async (
  db: D1Database,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(db, deleteDomainBlockSql(id));
    return rows.length > 0;
  });

/** Domains hidden from public surfaces (silence + suspend). */
export const restrictedDomains = async (db: D1Database): Promise<ReadonlySet<string>> => {
  const rows = await runD1(async () =>
    queryTyped<{ domain: string }>(db, listRestrictedDomainsSql()),
  );
  return new Set((rows.isOk() ? rows.value : []).map((row) => row.domain.toLowerCase()));
};

/** Domains federation is refused with (suspend). */
export const suspendedDomains = async (db: D1Database): Promise<ReadonlySet<string>> => {
  const rows = await runD1(async () =>
    queryTyped<{ domain: string }>(db, listSuspendedDomainsSql()),
  );
  return new Set((rows.isOk() ? rows.value : []).map((row) => row.domain.toLowerCase()));
};

export const domainBlockDocument = (row: DomainBlockRow): Record<string, unknown> => ({
  id: row.id,
  domain: row.domain,
  severity: row.severity,
  reject_media: row.reject_media !== 0,
  reject_reports: row.reject_reports !== 0,
  obfuscate: row.obfuscate !== 0,
  private_comment: row.private_comment,
  public_comment: row.public_comment,
  created_at: row.created_at,
});
