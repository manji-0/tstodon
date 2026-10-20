import { schemaResult, type ValidationError } from "@tstodon/core";
import { InstanceIdentity } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { domainAllowHosts } from "./domain-allow-store";
import type { CustomEmoji } from "./emoji";

const envSchema = z.object({
  INSTANCE_DOMAIN: z.string().trim().min(1),
  INSTANCE_PUBLIC_ORIGIN: z.string().trim().optional(),
  INSTANCE_NAME: z.string().trim().min(1),
  INSTANCE_DESCRIPTION: z.string(),
  SOURCE_URL: z.url(),
  INSTANCE_LANGUAGES: z.string().min(1),
  CONTACT_EMAIL: z.string().min(1),
  INSTANCE_THUMBNAIL_URL: z.url(),
  MEDIA_PUBLIC_BASE_URL: z.url(),
  FEDERATION_ALLOW_HOSTS: z.string().optional(),
});

const parseEnv = schemaResult(envSchema);

/**
 * Parse a JSON array from an optional env var. Empty or malformed input yields
 * no entries rather than failing the request.
 */
/** Parse an optional JSON env var; empty or malformed input yields `undefined`. */
const parseJsonValue = <T>(schema: z.ZodType<T>, raw: string): T | undefined => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const parsed = schemaResult(schema)(json);
  return parsed.isOk() ? parsed.value : undefined;
};

const parseJsonArray = <T>(schema: z.ZodType<T[]>, raw: string): ReadonlyArray<T> => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return [];
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const parsed = schemaResult(schema)(json);
  return parsed.isOk() ? parsed.value : [];
};

export const instanceRules = (env: Env): ReadonlyArray<InstanceRule> =>
  parseInstanceRules(`${(env as { INSTANCE_RULES?: string }).INSTANCE_RULES ?? ""}`);

const instanceRulesSchema = z.array(
  z.union([
    z.string().min(1),
    z.object({ text: z.string().min(1), hint: z.string().min(1).optional() }),
  ]),
);

export type InstanceRule = Readonly<{ id: string; text: string; hint?: string }>;

/**
 * Parse `INSTANCE_RULES`: a JSON array of strings or `{ text, hint? }` objects.
 */
export const parseInstanceRules = (raw: string): ReadonlyArray<InstanceRule> =>
  parseJsonArray(instanceRulesSchema, raw).map((entry, index) => {
    const id = String(index + 1);
    if (typeof entry === "string") {
      return { id, text: entry };
    }
    return entry.hint ? { id, text: entry.text, hint: entry.hint } : { id, text: entry.text };
  });

const customEmojiSchema = z.object({
  shortcode: z.string().regex(/^[a-zA-Z0-9_]+$/),
  url: z.string().min(1),
  static_url: z.string().min(1).optional(),
  visible_in_picker: z.boolean().optional(),
  category: z.string().min(1).optional(),
});

export const customEmojis = (env: Env): ReadonlyArray<CustomEmoji> =>
  parseCustomEmojis(`${(env as { CUSTOM_EMOJIS?: string }).CUSTOM_EMOJIS ?? ""}`);

/**
 * Parse `CUSTOM_EMOJIS`: a JSON array of `{ shortcode, url, static_url?,
 * visible_in_picker?, category? }`.
 */
export const parseCustomEmojis = (raw: string): ReadonlyArray<CustomEmoji> =>
  parseJsonArray(z.array(customEmojiSchema), raw).map((entry) => {
    const emoji: CustomEmoji = {
      shortcode: entry.shortcode,
      url: entry.url,
      static_url: entry.static_url ?? entry.url,
      visible_in_picker: entry.visible_in_picker ?? true,
    };
    return entry.category !== undefined ? { ...emoji, category: entry.category } : emoji;
  });

const announcementSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  starts_at: z.string().min(1).nullable().optional(),
  ends_at: z.string().min(1).nullable().optional(),
  all_day: z.boolean().optional(),
  published_at: z.string().min(1).nullable().optional(),
  updated_at: z.string().min(1).nullable().optional(),
  reactions: z
    .array(z.union([z.string().min(1), z.object({ name: z.string().min(1) })]))
    .optional(),
});

export type Announcement = Readonly<{
  id: string;
  content: string;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  publishedAt: string | null;
  updatedAt: string | null;
  reactions: ReadonlyArray<string>;
}>;

export const announcements = (env: Env): ReadonlyArray<Announcement> =>
  parseAnnouncements(`${(env as { ANNOUNCEMENTS?: string }).ANNOUNCEMENTS ?? ""}`);

/**
 * Parse `ANNOUNCEMENTS`: a JSON array of Mastodon announcement objects
 * (`{ id, content, starts_at?, ends_at?, all_day?, published_at?, updated_at?,
 * reactions? }`).
 */
export const parseAnnouncements = (raw: string): ReadonlyArray<Announcement> =>
  parseJsonArray(z.array(announcementSchema), raw).map((entry) => ({
    id: entry.id,
    content: entry.content,
    startsAt: entry.starts_at ?? null,
    endsAt: entry.ends_at ?? null,
    allDay: entry.all_day ?? false,
    publishedAt: entry.published_at ?? null,
    updatedAt: entry.updated_at ?? null,
    reactions: (entry.reactions ?? []).map((reaction) =>
      typeof reaction === "string" ? reaction : reaction.name,
    ),
  }));

/** Announcements that are live for the viewer at `now`. */
export const activeAnnouncements = (
  list: ReadonlyArray<Announcement>,
  now: number = Date.now(),
): ReadonlyArray<Announcement> =>
  list.filter((announcement) => {
    if (announcement.publishedAt && Date.parse(announcement.publishedAt) > now) {
      return false;
    }
    if (announcement.endsAt && Date.parse(announcement.endsAt) <= now) {
      return false;
    }
    return true;
  });

/** Optional description of the instance thumbnail (`INSTANCE_THUMBNAIL_DESCRIPTION`). */
export const thumbnailDescription = (env: Env): string | undefined => {
  const raw =
    `${(env as { INSTANCE_THUMBNAIL_DESCRIPTION?: string }).INSTANCE_THUMBNAIL_DESCRIPTION ?? ""}`.trim();
  return raw.length > 0 ? raw : undefined;
};

const policyDocumentSchema = z.object({
  content: z.string(),
  updated_at: z.string().min(1).optional(),
});

export type PolicyDocument = Readonly<{ content: string; updatedAt: string | null }>;

const toPolicyDocument = (raw: z.infer<typeof policyDocumentSchema>): PolicyDocument => ({
  content: raw.content,
  updatedAt: raw.updated_at ?? null,
});

/** `INSTANCE_EXTENDED_DESCRIPTION`: JSON `{ content, updated_at? }`. */
export const extendedDescription = (env: Env): PolicyDocument | undefined => {
  const parsed = parseJsonValue(
    policyDocumentSchema,
    `${(env as { INSTANCE_EXTENDED_DESCRIPTION?: string }).INSTANCE_EXTENDED_DESCRIPTION ?? ""}`,
  );
  return parsed ? toPolicyDocument(parsed) : undefined;
};

/** `INSTANCE_PRIVACY_POLICY`: JSON `{ content, updated_at? }`. */
export const privacyPolicy = (env: Env): PolicyDocument | undefined => {
  const parsed = parseJsonValue(
    policyDocumentSchema,
    `${(env as { INSTANCE_PRIVACY_POLICY?: string }).INSTANCE_PRIVACY_POLICY ?? ""}`,
  );
  return parsed ? toPolicyDocument(parsed) : undefined;
};

const termsOfServiceSchema = z.object({
  content: z.string(),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type TermsOfService = Readonly<{ content: string; effectiveDate: string }>;

/** `INSTANCE_TERMS_OF_SERVICE`: JSON `{ content, effective_date }`. */
export const termsOfService = (env: Env): TermsOfService | undefined => {
  const parsed = parseJsonValue(
    termsOfServiceSchema,
    `${(env as { INSTANCE_TERMS_OF_SERVICE?: string }).INSTANCE_TERMS_OF_SERVICE ?? ""}`,
  );
  return parsed ? { content: parsed.content, effectiveDate: parsed.effective_date } : undefined;
};

const envFederationAllowHosts = (env: Env): ReadonlySet<string> => {
  const raw = `${(env as { FEDERATION_ALLOW_HOSTS?: string }).FEDERATION_ALLOW_HOSTS ?? ""}`;
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );
};

/**
 * The hosts allowed to federate: `FEDERATION_ALLOW_HOSTS` plus the domains an
 * admin allowed at runtime (`domain_allows`). A non-empty set puts the instance
 * in limited federation, so adding the first allowed domain does too. A failed
 * read falls back to the configured hosts, which is the narrower answer when
 * the config already lists domains.
 */
export const federationAllowHosts = async (env: Env): Promise<ReadonlySet<string>> => {
  const configured = envFederationAllowHosts(env);
  const db = (env as { DB?: D1Database }).DB;
  if (!db) {
    return configured;
  }
  const stored = await domainAllowHosts(db);
  if (stored.isErr() || stored.value.size === 0) {
    return configured;
  }
  return new Set([...configured, ...stored.value]);
};

/** True when this host may federate: no allow list, or the host is on it. */
export const federatesWithHost = async (env: Env, hostname: string): Promise<boolean> => {
  const allow = await federationAllowHosts(env);
  return allow.size === 0 || allow.has(hostname.toLowerCase());
};

/** True when an allowlist is configured, which Mastodon calls limited federation. */
export const isLimitedFederation = async (env: Env): Promise<boolean> =>
  (await federationAllowHosts(env)).size > 0;

/**
 * `REGISTRATION_APPROVAL`: when set, a newly provisioned local account starts
 * pending until an admin approves it. Advertised as
 * `registrations.approval_required` and enforced by marking the account
 * unsearchable until then.
 */
export const registrationApprovalRequired = (
  env: Readonly<{ REGISTRATION_APPROVAL?: string }>,
): boolean => {
  const raw = env.REGISTRATION_APPROVAL ?? "";
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
};

export const parseInstanceIdentity = (env: Env): Result<InstanceIdentity, ValidationError> =>
  parseEnv(env).andThen((vars) => {
    const publicOrigin =
      vars.INSTANCE_PUBLIC_ORIGIN && vars.INSTANCE_PUBLIC_ORIGIN.length > 0
        ? vars.INSTANCE_PUBLIC_ORIGIN
        : `https://${vars.INSTANCE_DOMAIN}`;
    return InstanceIdentity.parse({
      kind: "InstanceIdentity",
      domain: vars.INSTANCE_DOMAIN,
      publicOrigin,
      name: vars.INSTANCE_NAME,
      description: vars.INSTANCE_DESCRIPTION,
      sourceUrl: vars.SOURCE_URL,
      languages: vars.INSTANCE_LANGUAGES.split(",").map((value) => value.trim()),
      contactEmail: vars.CONTACT_EMAIL,
      thumbnailUrl: vars.INSTANCE_THUMBNAIL_URL,
      mediaPublicBaseUrl: vars.MEDIA_PUBLIC_BASE_URL,
    });
  });
