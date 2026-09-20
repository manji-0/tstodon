import { schemaResult } from "@tstodon/core";
import { z } from "zod";

export const InstanceDomainBrand = Symbol("InstanceDomain");
const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .brand<typeof InstanceDomainBrand>();

export type InstanceDomain = z.infer<typeof domainSchema>;

export const InstanceIdentitySchema = z.object({
  kind: z.literal("InstanceIdentity"),
  domain: domainSchema,
  name: z.string().min(1),
  description: z.string(),
  sourceUrl: z.url(),
  languages: z.array(z.string().min(1)).min(1),
  contactEmail: z.string().min(1),
  thumbnailUrl: z.url(),
  mediaPublicBaseUrl: z.url(),
});

export type InstanceIdentity = z.infer<typeof InstanceIdentitySchema>;

export const InstanceIdentity = {
  schema: InstanceIdentitySchema,
  parse: schemaResult(InstanceIdentitySchema),
  actorUrl: (identity: InstanceIdentity, username: string): string =>
    `https://${identity.domain}/users/${username}`,
  webfingerSubject: (identity: InstanceIdentity, username: string): string =>
    `acct:${username}@${identity.domain}`,
  sharedInboxUrl: (identity: InstanceIdentity): string =>
    `https://${identity.domain}/inbox`,
} as const;
