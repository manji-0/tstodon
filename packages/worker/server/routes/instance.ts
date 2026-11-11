import type {
  ApiDomainBlockJSON,
  ApiInstanceActivityJSON,
  ApiInstanceJSON,
  ApiRuleJSON,
  ApiTermsOfServiceJSON,
  ApiV1InstanceJSON,
} from "@tstodon/api";
import { type Context } from "hono";
import { InstanceLimits, Languages } from "@tstodon/core";
import { countActiveAccounts } from "../account-activity";
import { countAccounts } from "../account-store";
import { ACTIVE_MONTH_DAYS } from "../nodeinfo";
import { listPublicDomainBlocks, publicDomainBlockDocument } from "../admin-domain-block-store";
import { jsonAuthError, jsonRepositoryError, requireUser } from "../http";
import {
  extendedDescription,
  instanceRules,
  isLimitedFederation,
  parseInstanceIdentity,
  privacyPolicy,
  registrationApprovalRequired,
  registrationsOpen,
  termsOfService,
  thumbnailDescription,
} from "../runtime-config";
import { countStatuses } from "../status-store";
import { vapidPublicKey } from "../vapid";
import { listPeerDomains } from "../remote-actor-store";
import { listWeeklyStatusActivity } from "../status-discovery-store";

/** `INSTANCE_EXTENDED_DESCRIPTION`, when configured. */
export const getV1InstanceExtendedDescription = (
  c: Context<{ Bindings: Env }, "/api/v1/instance/extended_description">,
) => {
  const document = extendedDescription(c.env);
  if (!document) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({ updated_at: document.updatedAt, content: document.content });
};

/** `INSTANCE_PRIVACY_POLICY`, when configured. */
export const getV1InstancePrivacyPolicy = (
  c: Context<{ Bindings: Env }, "/api/v1/instance/privacy_policy">,
) => {
  const document = privacyPolicy(c.env);
  if (!document) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json({ updated_at: document.updatedAt, content: document.content });
};

const termsOfServiceDocument = (env: Env): ApiTermsOfServiceJSON | undefined => {
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
export const getV1InstanceTermsOfService = (
  c: Context<{ Bindings: Env }, "/api/v1/instance/terms_of_service">,
) => {
  const document = termsOfServiceDocument(c.env);
  if (!document) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(document);
};

/** The same document, requested for a specific effective date. */
export const getV1InstanceTermsOfServiceByDate = (
  c: Context<{ Bindings: Env }, "/api/v1/instance/terms_of_service/:date">,
) => {
  const document = termsOfServiceDocument(c.env);
  if (!document || document.effective_date !== c.req.param("date")) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(document);
};

/** ISO 639-1 languages a status can be tagged with. */
export const getV1InstanceLanguages = (
  c: Context<{ Bindings: Env }, "/api/v1/instance/languages">,
) => c.json(Languages.map(([code, name]) => ({ code, name })));

/**
 * No translation backend is configured, so there are no language pairs; the
 * v2 instance document reports `translation.enabled: false` to match.
 */
export const getV1InstanceTranslationLanguages = (
  c: Context<{ Bindings: Env }, "/api/v1/instance/translation_languages">,
) => c.json({});

/** Public list of moderated servers (`noop` entries stay private, obfuscated ones hash the name). */
export const getV1InstanceDomainBlocks = async (
  c: Context<{ Bindings: Env }, "/api/v1/instance/domain_blocks">,
) => {
  const blocks = await listPublicDomainBlocks(c.env.DB);
  if (blocks.isErr()) {
    return jsonRepositoryError(c, blocks.error.message);
  }
  const documents: ApiDomainBlockJSON[] = [];
  for (const block of blocks.value) {
    const document = await publicDomainBlockDocument(block);
    if (document) {
      documents.push(document);
    }
  }
  return c.json(documents);
};

export const getV1Instance = async (c: Context<{ Bindings: Env }, "/api/v1/instance">) => {
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
  const document: ApiV1InstanceJSON = {
    uri: instance.domain,
    title: instance.name,
    short_description: instance.description,
    description: instance.description,
    email: instance.contactEmail,
    version: "0.1.0 (compatible; tstodon)",
    urls: { streaming_api: `wss://${instance.domain}` },
    stats: {
      user_count: users.value,
      status_count: statuses.value,
      domain_count: 1,
    },
    thumbnail: instance.thumbnailUrl,
    languages: instance.languages,
    registrations: registrationsOpen(c.env),
    approval_required: registrationApprovalRequired(c.env),
    invites_enabled: false,
    configuration: {
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
        supported_mime_types: [...InstanceLimits.media.supportedMimeTypes],
        image_size_limit: InstanceLimits.media.imageSizeLimit,
        image_matrix_limit: InstanceLimits.media.imageMatrixLimit,
        video_size_limit: InstanceLimits.media.videoSizeLimit,
        video_frame_rate_limit: InstanceLimits.media.videoFrameRateLimit,
        video_matrix_limit: InstanceLimits.media.videoMatrixLimit,
      },
      polls: {
        max_options: InstanceLimits.poll.maxOptions,
        max_characters_per_option: InstanceLimits.poll.maxOptionCharacters,
        min_expiration: InstanceLimits.poll.minExpirationSeconds,
        max_expiration: InstanceLimits.poll.maxExpirationSeconds,
      },
    },
    contact_account: null,
    rules: ruleDocuments(c.env),
  };
  return c.json(document);
};

/** `INSTANCE_RULES` as Mastodon's Rule entities: a rule without a hint has an empty one. */
const ruleDocuments = (env: Env): ApiRuleJSON[] =>
  instanceRules(env).map((rule) => ({ id: rule.id, text: rule.text, hint: rule.hint ?? "" }));

export const getV1InstanceRules = (c: Context<{ Bindings: Env }, "/api/v1/instance/rules">) =>
  c.json(ruleDocuments(c.env));

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

export const getV1InstancePeers = async (
  c: Context<{ Bindings: Env }, "/api/v1/instance/peers">,
) => {
  const denied = await requireUserWhenLimited(c);
  if (denied) {
    return denied;
  }
  const peers = await listPeerDomains(c.env.DB);
  if (peers.isErr()) {
    return jsonRepositoryError(c, peers.error.message);
  }
  return c.json(peers.value);
};

export const getV1InstanceActivity = async (
  c: Context<{ Bindings: Env }, "/api/v1/instance/activity">,
) => {
  const denied = await requireUserWhenLimited(c);
  if (denied) {
    return denied;
  }
  const activity = await listWeeklyStatusActivity(c.env.DB, 12);
  if (activity.isErr()) {
    return jsonRepositoryError(c, activity.error.message);
  }
  return c.json(
    activity.value.map((row): ApiInstanceActivityJSON => ({
      week: row.week,
      statuses: String(row.statuses),
      logins: "0",
      registrations: String(row.registrations),
    })),
  );
};

export const getV2Instance = async (c: Context<{ Bindings: Env }, "/api/v2/instance">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const activeMonth = await countActiveAccounts(c.env.DB, ACTIVE_MONTH_DAYS);
  const statuses = await countStatuses(c.env.DB);
  if (activeMonth.isErr()) {
    return jsonRepositoryError(c, activeMonth.error.message);
  }
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  const instance = identity.value;
  const description = thumbnailDescription(c.env);
  const document: ApiInstanceJSON = {
    domain: instance.domain,
    title: instance.name,
    version: "0.1.0 (compatible; tstodon)",
    source_url: instance.sourceUrl,
    description: instance.description,
    usage: {
      users: { active_month: activeMonth.value },
    },
    thumbnail: {
      url: instance.thumbnailUrl,
      ...(description ? { description } : {}),
    },
    languages: instance.languages,
    configuration: {
      urls: {
        streaming: `wss://${instance.domain}`,
        status: null,
        about: null,
        privacy_policy: privacyPolicy(c.env) ? `${instance.publicOrigin}/privacy-policy` : null,
        terms_of_service: termsOfService(c.env)
          ? `${instance.publicOrigin}/terms-of-service`
          : null,
      },
      vapid: { public_key: vapidPublicKey(c.env) },
      accounts: {
        max_display_name_length: InstanceLimits.account.maxDisplayNameCharacters,
        max_note_length: InstanceLimits.account.maxNoteCharacters,
        max_avatar_description_length: InstanceLimits.account.maxAvatarDescriptionCharacters,
        max_header_description_length: InstanceLimits.account.maxHeaderDescriptionCharacters,
        max_featured_tags: InstanceLimits.account.maxFeaturedTags,
        max_pinned_statuses: InstanceLimits.account.maxPinnedStatuses,
        max_profile_fields: InstanceLimits.account.maxProfileFields,
        profile_field_name_limit: InstanceLimits.account.maxProfileFieldNameCharacters,
        profile_field_value_limit: InstanceLimits.account.maxProfileFieldValueCharacters,
      },
      statuses: {
        max_characters: InstanceLimits.status.maxCharacters,
        max_media_attachments: InstanceLimits.status.maxMediaAttachments,
        characters_reserved_per_url: InstanceLimits.status.charactersReservedPerUrl,
      },
      media_attachments: {
        description_limit: InstanceLimits.media.maxDescriptionCharacters,
        image_matrix_limit: InstanceLimits.media.imageMatrixLimit,
        image_size_limit: InstanceLimits.media.imageSizeLimit,
        supported_mime_types: [...InstanceLimits.media.supportedMimeTypes],
        video_frame_rate_limit: InstanceLimits.media.videoFrameRateLimit,
        video_matrix_limit: InstanceLimits.media.videoMatrixLimit,
        video_size_limit: InstanceLimits.media.videoSizeLimit,
      },
      polls: {
        max_options: InstanceLimits.poll.maxOptions,
        max_characters_per_option: InstanceLimits.poll.maxOptionCharacters,
        min_expiration: InstanceLimits.poll.minExpirationSeconds,
        max_expiration: InstanceLimits.poll.maxExpirationSeconds,
      },
      translation: { enabled: false },
      // Mastodon 4.5: the live, hashtag and trending-link feeds are served to
      // anyone, local and remote content alike.
      timeline_access: {
        live_feeds: { local: "public", remote: "public" },
        hashtag_feeds: { local: "public", remote: "public" },
        trending_link_feeds: { local: "public", remote: "public" },
      },
      limited_federation: await isLimitedFederation(c.env),
    },
    registrations: {
      // A new Access login provisions an account when this is on.
      enabled: registrationsOpen(c.env),
      approval_required: registrationApprovalRequired(c.env),
      reason_required: false,
      message: null,
      min_age: 16,
      url: null,
    },
    contact: { email: instance.contactEmail, account: null },
    rules: ruleDocuments(c.env),
    // Mastodon gates features by API version. 8 adds `exclude_direct` on
    // `GET /api/v1/accounts/:id/statuses`.
    api_versions: { mastodon: 8 },
  };
  return c.json(document);
};
