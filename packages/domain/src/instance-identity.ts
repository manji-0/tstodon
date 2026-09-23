import { compileSchema, schemaResult } from "@tstodon/core";
import { z } from "zod";

export const InstanceDomainBrand = Symbol("InstanceDomain");
const rawDomainSchema = z.string().trim().toLowerCase().min(1).brand<typeof InstanceDomainBrand>();
const domainSchema = compileSchema(rawDomainSchema);

export type InstanceDomain = z.infer<typeof rawDomainSchema>;

export const InstanceIdentitySchema = z.object({
  kind: z.literal("InstanceIdentity"),
  domain: domainSchema,
  /** Absolute origin for actor/inbox URLs (may be http://host:port in local e2e). */
  publicOrigin: z.url(),
  name: z.string().min(1),
  description: z.string(),
  sourceUrl: z.url(),
  languages: z.array(z.string().min(1)).min(1),
  contactEmail: z.string().min(1),
  thumbnailUrl: z.url(),
  mediaPublicBaseUrl: z.url(),
});

export type InstanceIdentity = z.infer<typeof InstanceIdentitySchema>;

const origin = (identity: InstanceIdentity): string => identity.publicOrigin.replace(/\/$/, "");

export const InstanceIdentity = {
  schema: InstanceIdentitySchema,
  parse: schemaResult(InstanceIdentitySchema),
  actorUrl: (identity: InstanceIdentity, username: string): string =>
    `${origin(identity)}/users/${username}`,
  webfingerSubject: (identity: InstanceIdentity, username: string): string =>
    `acct:${username}@${identity.domain}`,
  sharedInboxUrl: (identity: InstanceIdentity): string => `${origin(identity)}/inbox`,
  webfingerUrl: (identity: InstanceIdentity, username: string): string =>
    `${origin(identity)}/.well-known/webfinger?resource=${encodeURIComponent(
      InstanceIdentity.webfingerSubject(identity, username),
    )}`,
} as const;
