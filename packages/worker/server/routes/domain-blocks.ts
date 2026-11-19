import { Hostname } from "@tstodon/domain";
import type { Context } from "hono";
import {
  ApiDomainBlockParamsSchema,
  ApiDomainBlockPreviewParamsSchema,
  type ApiDomainBlockPreviewJSON,
} from "@tstodon/api";
import { blockAccountDomain } from "../account-domain-block";
import { listBlockedDomains, previewDomainBlock, unblockDomain } from "../domain-block-store";
import { jsonAuthError, jsonRepositoryError, jsonValidationError, requireUser } from "../http";
import { readMergedParams, readParams, readQueryParams } from "../request-params";
import { parseInstanceIdentity } from "../runtime-config";

export const getV1DomainBlocks = async (c: Context<{ Bindings: Env }, "/api/v1/domain_blocks">) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const domains = await listBlockedDomains(c.env.DB, user.value.id);
  if (domains.isErr()) {
    return jsonRepositoryError(c, domains.error.message);
  }
  return c.json(domains.value);
};

/**
 * What blocking `domain` would sever, as Mastodon's
 * `Api::V1::DomainBlocks::PreviewsController`. Without a `domain`, Mastodon
 * counts the follows with local accounts (`where(domain: nil)`); one that is
 * not a hostname matches no account.
 */
export const getV1DomainBlocksPreview = async (
  c: Context<{ Bindings: Env }, "/api/v1/domain_blocks/preview">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const params = readQueryParams(c, ApiDomainBlockPreviewParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const raw = params.value.domain;
  const domain = raw === undefined ? undefined : Hostname.fromInput(raw);
  if (raw !== undefined && domain === undefined) {
    const none: ApiDomainBlockPreviewJSON = { following_count: 0, followers_count: 0 };
    return c.json(none);
  }
  const counted = await previewDomainBlock(
    c.env.DB,
    user.value.id,
    domain === undefined ? { kind: "Local" } : { kind: "Domain", domain },
  );
  if (counted.isErr()) {
    return jsonRepositoryError(c, counted.error.message);
  }
  const preview: ApiDomainBlockPreviewJSON = counted.value;
  return c.json(preview);
};

export const postV1DomainBlocks = async (
  c: Context<{ Bindings: Env }, "/api/v1/domain_blocks">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readParams(c, ApiDomainBlockParamsSchema);
  if (body.isErr()) {
    return c.json({ error: "domain is required", kind: "ValidationError" }, 422);
  }
  const domain = Hostname.fromInput(body.value.domain);
  if (domain === undefined) {
    return c.json({ error: "domain is required", kind: "ValidationError" }, 422);
  }
  if (domain === identity.value.domain.toLowerCase()) {
    return c.json({ error: "You cannot block your own domain", kind: "ValidationError" }, 422);
  }
  const blocked = await blockAccountDomain(c.env, identity.value, user.value, domain);
  if (blocked.isErr()) {
    return jsonRepositoryError(c, blocked.error.message);
  }
  return c.json({});
};

export const deleteV1DomainBlocks = async (
  c: Context<{ Bindings: Env }, "/api/v1/domain_blocks">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  // Mastodon's clients pass the domain in the query; a JSON or form body works too.
  const params = await readMergedParams(c, ApiDomainBlockParamsSchema);
  const domain = params.isOk() ? Hostname.fromInput(params.value.domain) : undefined;
  if (domain === undefined) {
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
};
