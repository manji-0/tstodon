import type { ApiAdminDomainBlockJSON, ApiDomainBlockJSON } from "@tstodon/api";
import { Hostname } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { okValues, parseRows, runD1, type RepositoryError } from "./d1";
import { domainPolicyCopy, readDomainPolicy } from "./domain-policy-revision";
import {
  deleteDomainBlock as deleteDomainBlockSql,
  findDomainBlockByDomain as findDomainBlockByDomainSql,
  findDomainBlockById as findDomainBlockByIdSql,
  insertDomainBlock as insertDomainBlockSql,
  clearRemoteMediaForDomain as clearRemoteMediaForDomainSql,
  listMediaRejectedDomains as listMediaRejectedDomainsSql,
  listPublicDomainBlocks as listPublicDomainBlocksSql,
  listRestrictedDomains as listRestrictedDomainsSql,
  listSuspendedDomains as listSuspendedDomainsSql,
  updateDomainBlock as updateDomainBlockSql,
} from "./generated/prisma/sql";
import { newEntityId } from "./ids";
import { idCursorFragment, type IdCursor } from "./id-cursor";
import { queryTyped, runTyped } from "./typed-sql";

const IdRow = z.object({ id: z.string() });
const DomainRow = z.object({ domain: z.string() });

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
  cursor: IdCursor = { maxId: maxId ?? undefined },
): Promise<Result<DomainBlockRow[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT id, domain, severity, reject_media, reject_reports, obfuscate, private_comment, public_comment, created_at
         FROM domain_blocks WHERE 1 = 1 ${where} ${order} LIMIT ?`,
      )
      .bind(...binds, limit)
      .all();
    return okValues((results ?? []).map((raw) => parseRow(raw)));
  });

export const findDomainBlockById = async (
  db: D1Database,
  id: string,
): Promise<Result<DomainBlockRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findDomainBlockByIdSql(id), DomainBlockRowSchema);
    return rows[0];
  });

export const findDomainBlockByDomain = async (
  db: D1Database,
  domain: Hostname,
): Promise<Result<DomainBlockRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findDomainBlockByDomainSql(domain), DomainBlockRowSchema);
    return rows[0];
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
    const rows = await queryTyped(
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
      IdRow,
    );
    return rows.length > 0;
  });

export const deleteDomainBlock = async (
  db: D1Database,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, deleteDomainBlockSql(id), IdRow);
    return rows.length > 0;
  });

/** Domains hidden from public surfaces (silence + suspend). */
export const restrictedDomains = async (db: D1Database): Promise<ReadonlySet<Hostname>> => {
  const rows = await runD1(async () => queryTyped(db, listRestrictedDomainsSql(), DomainRow));
  return new Set((rows.isOk() ? rows.value : []).map((row) => Hostname.ofAuthority(row.domain)));
};

const hostnames = (rows: ReadonlyArray<unknown>): ReadonlySet<Hostname> =>
  new Set(parseRows(DomainRow, rows).map((row) => Hostname.ofAuthority(row.domain)));

const suspendedCopy = domainPolicyCopy<ReadonlySet<Hostname>>();

/** Domains federation is refused with (suspend). */
export const suspendedDomains = async (db: D1Database): Promise<ReadonlySet<Hostname>> =>
  (await readDomainPolicy(db, suspendedCopy, listSuspendedDomainsSql(), hostnames)).unwrapOr(
    new Set<Hostname>(),
  );

export const domainBlockDocument = async (
  row: DomainBlockRow,
): Promise<ApiAdminDomainBlockJSON> => ({
  id: row.id,
  domain: row.domain,
  digest: await domainDigest(row.domain),
  severity: row.severity,
  reject_media: row.reject_media !== 0,
  reject_reports: row.reject_reports !== 0,
  obfuscate: row.obfuscate !== 0,
  private_comment: row.private_comment,
  public_comment: row.public_comment,
  created_at: row.created_at,
});

/** Lowercase hex SHA-256 of the domain, as Mastodon's public digest. */
export const domainDigest = async (domain: string): Promise<string> => {
  const bytes = new TextEncoder().encode(domain);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Blocks shown publicly by `GET /api/v1/instance/domain_blocks` (`noop` is omitted). */
export const listPublicDomainBlocks = async (
  db: D1Database,
): Promise<Result<DomainBlockRow[], RepositoryError>> =>
  runD1(async () => {
    return queryTyped(db, listPublicDomainBlocksSql(), DomainBlockRowSchema);
  });

export const publicDomainBlockDocument = async (
  row: DomainBlockRow,
): Promise<ApiDomainBlockJSON | undefined> => {
  // The query leaves `noop` out; a public block is a silence or a suspension.
  if (row.severity === "noop") {
    return undefined;
  }
  const digest = await domainDigest(row.domain);
  return {
    domain: row.obfuscate !== 0 ? digest : row.domain,
    digest,
    severity: row.severity,
    comment: row.public_comment,
  };
};

const mediaRejectedCopy = domainPolicyCopy<ReadonlySet<Hostname>>();

/** Domains whose remote media must not be kept (`reject_media`). */
export const mediaRejectedDomains = async (db: D1Database): Promise<ReadonlySet<Hostname>> =>
  (
    await readDomainPolicy(db, mediaRejectedCopy, listMediaRejectedDomainsSql(), hostnames)
  ).unwrapOr(new Set<Hostname>());

/** Called when a block starts rejecting media so stored attachments go away too. */
export const clearRemoteMediaForDomain = async (
  db: D1Database,
  domain: Hostname,
): Promise<Result<void, RepositoryError>> => {
  const cleared = await runD1(async () => {
    await runTyped(db, clearRemoteMediaForDomainSql(domain, nowIso()));
  });
  return cleared.map(() => undefined);
};
