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
