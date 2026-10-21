import { type Context, Hono } from "hono";
import { InstanceLimits, Languages } from "@tstodon/core";
import { countAccounts } from "../account-store";
import { listPublicDomainBlocks, publicDomainBlockDocument } from "../admin-domain-block-store";
import { jsonAuthError, jsonRepositoryError, requireUser } from "../http";
import {
  extendedDescription,
  instanceRules,
  isLimitedFederation,
  parseInstanceIdentity,
  privacyPolicy,
  registrationApprovalRequired,
  termsOfService,
  thumbnailDescription,
} from "../runtime-config";
import { countStatuses } from "../status-store";
import { vapidPublicKey } from "../vapid";
import { listPeerDomains } from "../remote-actor-store";
import { listWeeklyStatusActivity } from "../status-discovery-store";

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

/** ISO 639-1 languages a status can be tagged with. */
instanceRoutes.get("/api/v1/instance/languages", (c) =>
  c.json(Languages.map(([code, name]) => ({ code, name }))),
);

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

instanceRoutes.get("/api/v1/instance/rules", (c) => c.json(instanceRules(c.env)));

/** Mastodon requires a user token for peers and activity under limited federation. */
const requireUserWhenLimited = async (
  c: Context<{ Bindings: Env }>,
): Promise<Response | undefined> => {
  if (!(await isLimitedFederation(c.env))) {
    return undefined;
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  return undefined;
};

instanceRoutes.get("/api/v1/instance/peers", async (c) => {
  const denied = await requireUserWhenLimited(c);
  if (denied) {
    return denied;
  }
  const peers = await listPeerDomains(c.env.DB);
  if (peers.isErr()) {
    return jsonRepositoryError(c, peers.error.message);
  }
  return c.json(peers.value);
});

instanceRoutes.get("/api/v1/instance/activity", async (c) => {
  const denied = await requireUserWhenLimited(c);
  if (denied) {
    return denied;
  }
  const activity = await listWeeklyStatusActivity(c.env.DB, 12);
  if (activity.isErr()) {
    return jsonRepositoryError(c, activity.error.message);
  }
  return c.json(
    activity.value.map((row) => ({
      week: row.week,
      statuses: String(row.statuses),
      logins: "0",
      registrations: String(row.registrations),
    })),
  );
});

instanceRoutes.get("/api/v2/instance", async (c) => {
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
    domain: instance.domain,
    title: instance.name,
    version: "0.1.0 (compatible; tstodon)",
    source_url: instance.sourceUrl,
    description: instance.description,
    usage: {
      users: { active_month: users.value },
    },
    thumbnail: {
      url: instance.thumbnailUrl,
      ...(thumbnailDescription(c.env) ? { description: thumbnailDescription(c.env) } : {}),
    },
    languages: instance.languages,
    configuration: {
      urls: {
        streaming: `wss://${instance.domain}`,
        about: null,
        privacy_policy: privacyPolicy(c.env) ? `${instance.publicOrigin}/privacy-policy` : null,
        terms_of_service: termsOfService(c.env)
          ? `${instance.publicOrigin}/terms-of-service`
          : null,
      },
      vapid: { public_key: vapidPublicKey(c.env) },
      accounts: {
        max_featured_tags: InstanceLimits.account.maxFeaturedTags,
        max_pinned_statuses: InstanceLimits.account.maxPinnedStatuses,
      },
      statuses: {
        max_characters: InstanceLimits.status.maxCharacters,
        max_media_attachments: InstanceLimits.status.maxMediaAttachments,
        characters_reserved_per_url: InstanceLimits.status.charactersReservedPerUrl,
      },
      media_attachments: {
        description_limit: InstanceLimits.media.maxDescriptionCharacters,
        supported_mime_types: [...InstanceLimits.media.supportedMimeTypes],
      },
      polls: {
        max_options: InstanceLimits.poll.maxOptions,
        max_characters_per_option: InstanceLimits.poll.maxOptionCharacters,
        min_expiration: InstanceLimits.poll.minExpirationSeconds,
        max_expiration: InstanceLimits.poll.maxExpirationSeconds,
      },
      translation: { enabled: false },
      limited_federation: await isLimitedFederation(c.env),
    },
    registrations: {
      // No self-service registration: accounts come from Cloudflare Access.
      enabled: false,
      approval_required: registrationApprovalRequired(c.env),
      reason_required: false,
      message: null,
      min_age: 16,
      url: null,
    },
    contact: { email: instance.contactEmail, account: null },
    rules: instanceRules(c.env),
    // Mastodon gates features by API version; 2 covers the 4.3 set this server
    // implements (grouped notifications plus the notification policy/requests).
    api_versions: { mastodon: 7 },
  });
});
