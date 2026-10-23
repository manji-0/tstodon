import type { Context } from "hono";
import { z } from "zod";
import { normalizeDomain } from "../../domain-block-store";
import {
  deleteDomainAllow,
  type DomainAllowRow,
  findDomainAllowById,
  insertDomainAllow,
  listDomainAllows,
} from "../../domain-allow-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryAdminLimit,
  queryCursor,
  readOptionalBody,
  requireAdmin,
} from "../../http";

const domainAllowDocument = (row: DomainAllowRow): Record<string, unknown> => ({
  id: row.id,
  domain: row.domain,
  created_at: row.createdAt,
});

const DomainAllowBodySchema = z.object({ domain: z.string().optional() });

/** A bare hostname: at least two labels, no scheme, path, or port. */
const HOSTNAME_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export const getV1AdminDomainAllows = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/domain_allows">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const allows = await listDomainAllows(
    c.env.DB,
    queryAdminLimit(c.req.query("limit")),
    queryCursor(c),
  );
  if (allows.isErr()) {
    return jsonRepositoryError(c, allows.error.message);
  }
  return c.json(allows.value.map(domainAllowDocument));
};

export const getV1AdminDomainAllowsById = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/domain_allows/:id">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const allow = await findDomainAllowById(c.env.DB, c.req.param("id") ?? "");
  if (allow.isErr()) {
    return jsonRepositoryError(c, allow.error.message);
  }
  if (!allow.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(domainAllowDocument(allow.value));
};

export const postV1AdminDomainAllows = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/domain_allows">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readOptionalBody(c, DomainAllowBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const domain = normalizeDomain(body.value.domain ?? "");
  if (domain.length === 0 || !HOSTNAME_PATTERN.test(domain)) {
    return c.json({ error: "Validation failed: Domain is invalid", kind: "ValidationError" }, 422);
  }
  // Idempotent, like Mastodon: an already allowed domain answers its document.
  const saved = await insertDomainAllow(c.env.DB, domain);
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  return c.json(domainAllowDocument(saved.value));
};

export const deleteV1AdminDomainAllowsById = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/domain_allows/:id">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const removed = await deleteDomainAllow(c.env.DB, c.req.param("id") ?? "");
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  if (!removed.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({});
};
