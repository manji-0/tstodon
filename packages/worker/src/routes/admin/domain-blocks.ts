import { Hono } from "hono";
import { z } from "zod";
import {
  clearRemoteMediaForDomain,
  deleteDomainBlock,
  domainBlockDocument,
  DomainBlockSeveritySchema,
  findDomainBlockByDomain,
  findDomainBlockById,
  insertDomainBlock,
  listDomainBlocks,
  updateDomainBlock,
} from "../../admin-domain-block-store";
import { normalizeDomain } from "../../domain-block-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryAdminLimit,
  queryCursor,
  readBody,
  requireAdmin,
} from "../../http";
import { parseInstanceIdentity } from "../../runtime-config";
import { parseBool, validation } from "./shared";

export const adminDomainBlockRoutes = new Hono<{ Bindings: Env }>();

const AdminDomainBlockBodySchema = z.object({
  domain: z.string().min(1).optional(),
  severity: DomainBlockSeveritySchema.optional(),
  reject_media: z.union([z.boolean(), z.string(), z.number()]).optional(),
  reject_reports: z.union([z.boolean(), z.string(), z.number()]).optional(),
  obfuscate: z.union([z.boolean(), z.string(), z.number()]).optional(),
  private_comment: z.string().nullable().optional(),
  public_comment: z.string().nullable().optional(),
});

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

adminDomainBlockRoutes.get("/api/v1/admin/domain_blocks", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const blocks = await listDomainBlocks(
    c.env.DB,
    queryAdminLimit(c.req.query("limit")),
    c.req.query("max_id") ?? null,
    queryCursor(c),
  );
  if (blocks.isErr()) {
    return jsonRepositoryError(c, blocks.error.message);
  }
  return c.json(blocks.value.map(domainBlockDocument));
});

adminDomainBlockRoutes.get("/api/v1/admin/domain_blocks/:id", async (c) => {
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
  return c.json(domainBlockDocument(block.value));
});

adminDomainBlockRoutes.post("/api/v1/admin/domain_blocks", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readBody(c, AdminDomainBlockBodySchema);
  if (body.isErr() || body.value.domain === undefined) {
    return validation(c, "domain is required");
  }
  const domain = normalizeDomain(body.value.domain);
  if (domain.length === 0) {
    return validation(c, "domain is required");
  }
  if (domain === identity.value.domain.toLowerCase()) {
    return validation(c, "You cannot block your own domain");
  }
  const existing = await findDomainBlockByDomain(c.env.DB, domain);
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  if (existing.value) {
    return validation(c, "domain has already been blocked");
  }
  const created = await insertDomainBlock(c.env.DB, {
    domain,
    severity: body.value.severity ?? "silence",
    rejectMedia: parseBool(body.value.reject_media, false),
    rejectReports: parseBool(body.value.reject_reports, false),
    obfuscate: parseBool(body.value.obfuscate, false),
    privateComment: optionalComment(body.value.private_comment) ?? null,
    publicComment: optionalComment(body.value.public_comment) ?? null,
  });
  if (created.isErr()) {
    return jsonRepositoryError(c, created.error.message);
  }
  const block = await findDomainBlockById(c.env.DB, created.value);
  if (block.isErr() || !block.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (block.value.reject_media !== 0) {
    await clearRemoteMediaForDomain(c.env.DB, block.value.domain);
  }
  return c.json(domainBlockDocument(block.value));
});

adminDomainBlockRoutes.put("/api/v1/admin/domain_blocks/:id", async (c) => {
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
  const privateComment = optionalComment(body.value.private_comment);
  const publicComment = optionalComment(body.value.public_comment);
  const updated = await updateDomainBlock(c.env.DB, id, {
    severity: body.value.severity ?? existing.value.severity,
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
  const block = await findDomainBlockById(c.env.DB, id);
  if (block.isErr() || !block.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (block.value.reject_media !== 0) {
    await clearRemoteMediaForDomain(c.env.DB, block.value.domain);
  }
  return c.json(domainBlockDocument(block.value));
});

adminDomainBlockRoutes.delete("/api/v1/admin/domain_blocks/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const removed = await deleteDomainBlock(c.env.DB, c.req.param("id") ?? "");
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  if (!removed.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({});
});
