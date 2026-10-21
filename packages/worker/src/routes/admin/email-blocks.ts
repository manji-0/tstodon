import { Hono } from "hono";
import { z } from "zod";
import { normalizeDomain } from "../../domain-block-store";
import {
  canonicalEmailHash,
  deleteCanonicalEmailBlock,
  deleteEmailDomainBlock,
  type EmailDomainBlock,
  emailDomainHistory,
  findCanonicalEmailBlockByEmail,
  findCanonicalEmailBlockById,
  findEmailDomainBlockById,
  insertCanonicalEmailBlock,
  insertEmailDomainBlock,
  listCanonicalEmailBlocks,
  listEmailDomainBlocks,
} from "../../registration-block-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryAdminLimit,
  queryCursor,
  readOptionalBody,
  requireAdmin,
} from "../../http";

export const adminEmailBlockRoutes = new Hono<{ Bindings: Env }>();

const CanonicalEmailBlockBodySchema = z.object({
  email: z.string().optional(),
  canonical_email_hash: z.string().optional(),
});

const CanonicalEmailTestBodySchema = z.object({ email: z.string().optional() });

const EmailDomainBlockBodySchema = z.object({ domain: z.string().optional() });

adminEmailBlockRoutes.get("/api/v1/admin/canonical_email_blocks", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const blocks = await listCanonicalEmailBlocks(
    c.env.DB,
    queryAdminLimit(c.req.query("limit")),
    queryCursor(c),
  );
  if (blocks.isErr()) {
    return jsonRepositoryError(c, blocks.error.message);
  }
  return c.json(
    blocks.value.map((block) => ({ id: block.id, canonical_email_hash: block.canonicalEmailHash })),
  );
});

adminEmailBlockRoutes.get("/api/v1/admin/canonical_email_blocks/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const block = await findCanonicalEmailBlockById(c.env.DB, c.req.param("id") ?? "");
  if (block.isErr()) {
    return jsonRepositoryError(c, block.error.message);
  }
  if (!block.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({ id: block.value.id, canonical_email_hash: block.value.canonicalEmailHash });
});

/** `POST /test` answers the block an email would hit, without creating one. */
adminEmailBlockRoutes.post("/api/v1/admin/canonical_email_blocks/test", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readOptionalBody(c, CanonicalEmailTestBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const email = (body.value.email ?? "").trim();
  if (email.length === 0) {
    return jsonValidationError(c);
  }
  const block = await findCanonicalEmailBlockByEmail(c.env.DB, email);
  if (block.isErr()) {
    return jsonRepositoryError(c, block.error.message);
  }
  if (!block.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({ id: block.value.id, canonical_email_hash: block.value.canonicalEmailHash });
});

adminEmailBlockRoutes.post("/api/v1/admin/canonical_email_blocks", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readOptionalBody(c, CanonicalEmailBlockBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const email = (body.value.email ?? "").trim();
  const given = (body.value.canonical_email_hash ?? "").trim();
  let hash: string;
  if (email.length > 0) {
    hash = await canonicalEmailHash(email);
  } else if (given.length > 0) {
    hash = given;
  } else {
    return jsonValidationError(c);
  }
  const blocked = await insertCanonicalEmailBlock(c.env.DB, hash);
  if (blocked.isErr()) {
    // The unique index refuses a hash that is already blocked.
    return c.json(
      {
        error: "Validation failed: Canonical email hash has already been taken",
        kind: "ValidationError",
      },
      422,
    );
  }
  return c.json({ id: blocked.value.id, canonical_email_hash: blocked.value.canonicalEmailHash });
});

adminEmailBlockRoutes.delete("/api/v1/admin/canonical_email_blocks/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const removed = await deleteCanonicalEmailBlock(c.env.DB, c.req.param("id") ?? "");
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  if (!removed.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({});
});

const emailDomainBlockDocument = async (
  env: Env,
  block: EmailDomainBlock,
): Promise<Record<string, unknown>> => {
  const history = await emailDomainHistory(env.DB, block.domain);
  return {
    id: block.id,
    domain: block.domain,
    created_at: block.createdAt,
    history: history.isOk() ? history.value : [],
  };
};

adminEmailBlockRoutes.get("/api/v1/admin/email_domain_blocks", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const blocks = await listEmailDomainBlocks(
    c.env.DB,
    queryAdminLimit(c.req.query("limit")),
    queryCursor(c),
  );
  if (blocks.isErr()) {
    return jsonRepositoryError(c, blocks.error.message);
  }
  const documents: Record<string, unknown>[] = [];
  for (const block of blocks.value) {
    documents.push(await emailDomainBlockDocument(c.env, block));
  }
  return c.json(documents);
});

adminEmailBlockRoutes.get("/api/v1/admin/email_domain_blocks/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const block = await findEmailDomainBlockById(c.env.DB, c.req.param("id") ?? "");
  if (block.isErr()) {
    return jsonRepositoryError(c, block.error.message);
  }
  if (!block.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await emailDomainBlockDocument(c.env, block.value));
});

adminEmailBlockRoutes.post("/api/v1/admin/email_domain_blocks", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readOptionalBody(c, EmailDomainBlockBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const domain = normalizeDomain(body.value.domain ?? "");
  if (domain.length === 0) {
    return jsonValidationError(c);
  }
  const blocked = await insertEmailDomainBlock(c.env.DB, domain);
  if (blocked.isErr()) {
    return c.json(
      { error: "Validation failed: Domain has already been taken", kind: "ValidationError" },
      422,
    );
  }
  return c.json(await emailDomainBlockDocument(c.env, blocked.value));
});

adminEmailBlockRoutes.delete("/api/v1/admin/email_domain_blocks/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const removed = await deleteEmailDomainBlock(c.env.DB, c.req.param("id") ?? "");
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  if (!removed.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({});
});
