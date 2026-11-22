import type { ApiAdminExistingDomainBlockErrorJSON } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import type { Context } from "hono";
import { z } from "zod";
import {
  changeDomainBlock,
  createDomainBlock,
  type DomainBlockInvalidity,
  removeDomainBlock,
} from "../../admin-actions";
import {
  domainBlockDocument,
  type DomainBlockSeverity,
  DomainBlockSeveritySchema,
  findDomainBlockById,
  listDomainBlocks,
} from "../../admin-domain-block-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryLimit,
  queryCursor,
  readBody,
  requireAdmin,
  setPaginationLinks,
  PageSize,
} from "../../http";
import { parseInstanceIdentity } from "../../runtime-config";
import { parseBool, validation } from "./shared";

const AdminDomainBlockBodySchema = z.object({
  domain: z.string().optional(),
  severity: z.string().optional(),
  reject_media: z.union([z.boolean(), z.string(), z.number()]).optional(),
  reject_reports: z.union([z.boolean(), z.string(), z.number()]).optional(),
  obfuscate: z.union([z.boolean(), z.string(), z.number()]).optional(),
  private_comment: z.string().nullable().optional(),
  public_comment: z.string().nullable().optional(),
});

/** The severity a body names, or `fallback` without one; `undefined` when it names none Mastodon knows. */
const severityOf = (
  value: string | undefined,
  fallback: DomainBlockSeverity,
): DomainBlockSeverity | undefined =>
  value === undefined
    ? fallback
    : schemaResult(DomainBlockSeveritySchema)(value).unwrapOr(undefined);

/** ActiveModel's full messages for `DomainBlock`'s validations. */
const INVALIDITY_MESSAGES = {
  SeverityNotIncluded: "Severity is not included in the list",
  DomainBlank: "Domain can't be blank",
  DomainInvalid: "Domain is invalid",
} as const satisfies Record<DomainBlockInvalidity, string>;

const INVALID_SEVERITY = `Validation failed: ${INVALIDITY_MESSAGES.SeverityNotIncluded}`;

const optionalComment = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const getV1AdminDomainBlocks = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/domain_blocks">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const limit = queryLimit(c, PageSize.adminDomainRules);
  const blocks = await listDomainBlocks(
    c.env.DB,
    limit,
    c.req.query("max_id") ?? null,
    queryCursor(c),
  );
  if (blocks.isErr()) {
    return jsonRepositoryError(c, blocks.error.message);
  }
  setPaginationLinks(
    c,
    blocks.value.map((block) => block.id),
    limit,
  );
  return c.json(await Promise.all(blocks.value.map(domainBlockDocument)));
};

export const getV1AdminDomainBlocksById = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/domain_blocks/:id">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const block = await findDomainBlockById(c.env.DB, c.req.param("id") ?? "");
  if (block.isErr()) {
    return jsonRepositoryError(c, block.error.message);
  }
  if (!block.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await domainBlockDocument(block.value));
};

export const postV1AdminDomainBlocks = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/domain_blocks">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readBody(c, AdminDomainBlockBodySchema);
  if (body.isErr()) {
    return validation(c, "Validation failed");
  }
  const created = await createDomainBlock(c.env, identity.value.domain, body.value.domain ?? "", {
    severity: severityOf(body.value.severity, "silence"),
    rejectMedia: parseBool(body.value.reject_media, false),
    rejectReports: parseBool(body.value.reject_reports, false),
    obfuscate: parseBool(body.value.obfuscate, false),
    privateComment: optionalComment(body.value.private_comment) ?? null,
    publicComment: optionalComment(body.value.public_comment) ?? null,
  });
  if (created.isErr()) {
    switch (created.error.kind) {
      case "ValidationFailed":
        return validation(
          c,
          `Validation failed: ${created.error.invalidities.map((invalidity) => INVALIDITY_MESSAGES[invalidity]).join(", ")}`,
        );
      case "OwnDomain":
        return validation(c, "You cannot block your own domain");
      case "ExistingDomainBlock": {
        const answer: ApiAdminExistingDomainBlockErrorJSON = {
          error: `You have already imposed stricter limits on ${created.error.existing.domain}.`,
          existing_domain_block: await domainBlockDocument(created.error.existing),
        };
        return c.json(answer, 422);
      }
      case "RepositoryError":
        return jsonRepositoryError(c, created.error.message);
    }
  }
  return created.value
    ? c.json(await domainBlockDocument(created.value))
    : c.json({ error: "Record not found", kind: "NotFound" }, 404);
};

export const putV1AdminDomainBlocksById = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/domain_blocks/:id">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const id = c.req.param("id") ?? "";
  const existing = await findDomainBlockById(c.env.DB, id);
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  if (!existing.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const body = await readBody(c, AdminDomainBlockBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const severity = severityOf(body.value.severity, existing.value.severity);
  if (severity === undefined) {
    return validation(c, INVALID_SEVERITY);
  }
  const privateComment = optionalComment(body.value.private_comment);
  const publicComment = optionalComment(body.value.public_comment);
  const updated = await changeDomainBlock(c.env, id, {
    severity,
    rejectMedia:
      body.value.reject_media === undefined
        ? existing.value.reject_media !== 0
        : parseBool(body.value.reject_media, false),
    rejectReports:
      body.value.reject_reports === undefined
        ? existing.value.reject_reports !== 0
        : parseBool(body.value.reject_reports, false),
    obfuscate:
      body.value.obfuscate === undefined
        ? existing.value.obfuscate !== 0
        : parseBool(body.value.obfuscate, false),
    privateComment: privateComment === undefined ? existing.value.private_comment : privateComment,
    publicComment: publicComment === undefined ? existing.value.public_comment : publicComment,
  });
  if (updated.isErr()) {
    return jsonRepositoryError(c, updated.error.message);
  }
  return updated.value
    ? c.json(await domainBlockDocument(updated.value))
    : c.json({ error: "Record not found", kind: "NotFound" }, 404);
};

export const deleteV1AdminDomainBlocksById = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/domain_blocks/:id">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const removed = await removeDomainBlock(c.env, c.req.param("id") ?? "");
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  if (!removed.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({});
};
