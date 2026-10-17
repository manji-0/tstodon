import { schemaResult, type ValidationError } from "@tstodon/core";
import { InstanceIdentity } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";

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

export const instanceRules = (env: Env): ReadonlyArray<InstanceRule> =>
  parseInstanceRules(`${(env as { INSTANCE_RULES?: string }).INSTANCE_RULES ?? ""}`);

const instanceRulesSchema = z.array(
  z.union([
    z.string().min(1),
    z.object({ text: z.string().min(1), hint: z.string().min(1).optional() }),
  ]),
);

const parseInstanceRulesResult = schemaResult(instanceRulesSchema);

export type InstanceRule = Readonly<{ id: string; text: string; hint?: string }>;

/**
 * Parse `INSTANCE_RULES`: a JSON array of strings or `{ text, hint? }` objects.
 * Anything malformed yields no rules rather than failing the instance.
 */
export const parseInstanceRules = (raw: string): ReadonlyArray<InstanceRule> => {
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
  const parsed = parseInstanceRulesResult(json);
  if (parsed.isErr()) {
    return [];
  }
  return parsed.value.map((entry, index) => {
    const id = String(index + 1);
    if (typeof entry === "string") {
      return { id, text: entry };
    }
    return entry.hint ? { id, text: entry.text, hint: entry.hint } : { id, text: entry.text };
  });
};

export const federationAllowHosts = (env: Env): ReadonlySet<string> => {
  const raw = `${(env as { FEDERATION_ALLOW_HOSTS?: string }).FEDERATION_ALLOW_HOSTS ?? ""}`;
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );
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
