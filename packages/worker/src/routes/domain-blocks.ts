import { Hono } from "hono";
import { z } from "zod";
import {
  blockDomain,
  listBlockedDomains,
  normalizeDomain,
  unblockDomain,
} from "../domain-block-store";
import { jsonAuthError, jsonRepositoryError, readBody, requireUser } from "../http";
import { parseInstanceIdentity } from "../runtime-config";

export const domainBlockRoutes = new Hono<{ Bindings: Env }>();

const DomainBodySchema = z.object({ domain: z.string().min(1) });

domainBlockRoutes.get("/api/v1/domain_blocks", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const domains = await listBlockedDomains(c.env.DB, user.value.id);
  if (domains.isErr()) {
    return jsonRepositoryError(c, domains.error.message);
  }
  return c.json(domains.value);
});

domainBlockRoutes.post("/api/v1/domain_blocks", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readBody(c, DomainBodySchema);
  if (body.isErr()) {
    return c.json({ error: "domain is required", kind: "ValidationError" }, 422);
  }
  const domain = normalizeDomain(body.value.domain);
  if (domain.length === 0) {
    return c.json({ error: "domain is required", kind: "ValidationError" }, 422);
  }
  if (domain === identity.value.domain.toLowerCase()) {
    return c.json({ error: "You cannot block your own domain", kind: "ValidationError" }, 422);
  }
  const blocked = await blockDomain(c.env.DB, user.value.id, domain);
  if (blocked.isErr()) {
    return jsonRepositoryError(c, blocked.error.message);
  }
  return c.json({});
});

domainBlockRoutes.delete("/api/v1/domain_blocks", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  // Mastodon passes the domain as a query parameter; a JSON/form body works too.
  let raw = c.req.query("domain") ?? "";
  if (raw.length === 0 && (c.req.header("content-type") ?? "").length > 0) {
    const body = await readBody(c, DomainBodySchema);
    if (body.isOk()) {
      raw = body.value.domain;
    }
  }
  const domain = normalizeDomain(raw);
  if (domain.length === 0) {
    return c.json({ error: "domain is required", kind: "ValidationError" }, 422);
  }
  const removed = await unblockDomain(c.env.DB, user.value.id, domain);
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  if (!removed.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({});
});
