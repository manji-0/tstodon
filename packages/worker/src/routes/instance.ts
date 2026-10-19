import { Hono } from "hono";
import { countAccounts } from "../account-store";
import { listPublicDomainBlocks, publicDomainBlockDocument } from "../admin-domain-block-store";
import { jsonRepositoryError } from "../http";
import {
  extendedDescription,
  parseInstanceIdentity,
  privacyPolicy,
  termsOfService,
} from "../runtime-config";
import { countStatuses } from "../status-store";

export const instanceRoutes = new Hono<{ Bindings: Env }>();

/** `INSTANCE_EXTENDED_DESCRIPTION`, when configured. */
instanceRoutes.get("/api/v1/instance/extended_description", (c) => {
  const document = extendedDescription(c.env);
  if (!document) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({ updated_at: document.updatedAt, content: document.content });
});

/** `INSTANCE_PRIVACY_POLICY`, when configured. */
instanceRoutes.get("/api/v1/instance/privacy_policy", (c) => {
  const document = privacyPolicy(c.env);
  if (!document) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({ updated_at: document.updatedAt, content: document.content });
});

const termsOfServiceDocument = (env: Env): Record<string, unknown> | undefined => {
  const terms = termsOfService(env);
  if (!terms) {
    return undefined;
  }
  return {
    effective_date: terms.effectiveDate,
    effective: true,
    content: terms.content,
    succeeded_by: null,
  };
};

/** `INSTANCE_TERMS_OF_SERVICE`, when configured. */
instanceRoutes.get("/api/v1/instance/terms_of_service", (c) => {
  const document = termsOfServiceDocument(c.env);
  if (!document) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(document);
});

/** The same document, requested for a specific effective date. */
instanceRoutes.get("/api/v1/instance/terms_of_service/:date", (c) => {
  const document = termsOfServiceDocument(c.env);
  if (!document || document.effective_date !== c.req.param("date")) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(document);
});

/**
 * No translation backend is configured, so there are no language pairs; the
 * v2 instance document reports `translation.enabled: false` to match.
 */
instanceRoutes.get("/api/v1/instance/translation_languages", (c) => c.json({}));

/** Public list of moderated servers (`noop` entries stay private, obfuscated ones hash the name). */
instanceRoutes.get("/api/v1/instance/domain_blocks", async (c) => {
  const blocks = await listPublicDomainBlocks(c.env.DB);
  if (blocks.isErr()) {
    return jsonRepositoryError(c, blocks.error.message);
  }
  const documents: Record<string, unknown>[] = [];
  for (const block of blocks.value) {
    documents.push(await publicDomainBlockDocument(block));
  }
  return c.json(documents);
});

instanceRoutes.get("/api/v1/instance", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const users = await countAccounts(c.env.DB);
  const statuses = await countStatuses(c.env.DB);
  if (users.isErr()) {
    return jsonRepositoryError(c, users.error.message);
  }
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  const instance = identity.value;
  return c.json({
    kind: "MastodonInstance",
    uri: instance.domain,
    title: instance.name,
    short_description: instance.description,
    description: instance.description,
    email: instance.contactEmail,
    version: "0.1.0 (compatible; tstodon)",
    languages: instance.languages,
    registrations: false,
    approval_required: true,
    invites_enabled: false,
    configuration: {
      urls: {
        streaming: `wss://${instance.domain}`,
      },
    },
    thumbnail: instance.thumbnailUrl,
    source_url: instance.sourceUrl,
    stats: {
      user_count: users.value,
      status_count: statuses.value,
      domain_count: 1,
    },
  });
});
