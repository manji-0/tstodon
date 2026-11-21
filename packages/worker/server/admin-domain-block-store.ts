import type { ApiAdminDomainBlockJSON, ApiDomainBlockJSON } from "@tstodon/api";
import { CoveredHosts, Hostname } from "@tstodon/domain";
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
  listDomainBlockRules as listDomainBlockRulesSql,
  listPublicDomainBlocks as listPublicDomainBlocksSql,
  updateDomainBlock as updateDomainBlockSql,
} from "./generated/prisma/sql";
import { newEntityId } from "./ids";
import { hostKeyRange } from "./host-key";
import { idCursorFragment, type IdCursor } from "./id-cursor";
import { queryTyped, runTyped } from "./typed-sql";

const IdRow = z.object({ id: z.string() });

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

/**
 * The block that applies to `host`: Mastodon's `DomainBlock.rule_for`, the
 * block on the host or its nearest parent domain.
 */
export const findDomainBlockRule = async (
  db: D1Database,
  host: Hostname,
): Promise<Result<DomainBlockRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT id, domain, severity, reject_media, reject_reports, obfuscate, private_comment, public_comment, created_at
         FROM domain_blocks WHERE domain IN (SELECT value FROM json_each(?))
         ORDER BY length(domain) DESC LIMIT 1`,
      )
      .bind(JSON.stringify(Hostname.variants(host)))
      .all();
    return parseRows(DomainBlockRowSchema, results)[0];
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

const RuleRow = DomainBlockRowSchema.pick({
  domain: true,
  severity: true,
  reject_media: true,
  reject_reports: true,
});

/** The hosts each kind of instance domain rule covers, as `DomainBlock.rule_for` matches them. */
type DomainRuleHosts = Readonly<{
  suspended: CoveredHosts;
  mediaRejected: CoveredHosts;
  reportsRejected: CoveredHosts;
}>;

const NO_RULES: DomainRuleHosts = {
  suspended: CoveredHosts.none,
  mediaRejected: CoveredHosts.none,
  reportsRejected: CoveredHosts.none,
};

const ruleHosts = (rows: ReadonlyArray<unknown>): DomainRuleHosts => {
  const rules = parseRows(RuleRow, rows).map((row) => ({
    ...row,
    domain: Hostname.ofAuthority(row.domain),
  }));
  return {
    suspended: CoveredHosts.of(rules, (rule) => rule.severity === "suspend"),
    mediaRejected: CoveredHosts.of(rules, (rule) => rule.reject_media !== 0),
    reportsRejected: CoveredHosts.of(rules, (rule) => rule.reject_reports !== 0),
  };
};

const rulesCopy = domainPolicyCopy<DomainRuleHosts>();

const domainRuleHosts = async (db: D1Database): Promise<DomainRuleHosts> =>
  (await readDomainPolicy(db, rulesCopy, listDomainBlockRulesSql(), ruleHosts)).unwrapOr(NO_RULES);

/** Hosts federation is refused with: a suspended domain and its subdomains. */
export const suspendedDomains = async (db: D1Database): Promise<CoveredHosts> =>
  (await domainRuleHosts(db)).suspended;

/** Hosts whose reports are ignored (`reject_reports`), subdomains included. */
export const reportsRejectedDomains = async (db: D1Database): Promise<CoveredHosts> =>
  (await domainRuleHosts(db)).reportsRejected;

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

/** Hosts whose remote media must not be kept (`reject_media`), subdomains included. */
export const mediaRejectedDomains = async (db: D1Database): Promise<CoveredHosts> =>
  (await domainRuleHosts(db)).mediaRejected;

/**
 * Called when a block starts rejecting media so stored attachments go away
 * too, those of the domain's subdomains included, as `ClearDomainMediaService`.
 */
export const clearRemoteMediaForDomain = async (
  db: D1Database,
  domain: Hostname,
): Promise<Result<void, RepositoryError>> => {
  const { from, to } = hostKeyRange(domain);
  const cleared = await runD1(async () => {
    await runTyped(db, clearRemoteMediaForDomainSql(from, to, nowIso()));
  });
  return cleared.map(() => undefined);
};
