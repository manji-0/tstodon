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
  /** A local account's page in the web app, its `url` (Mastodon's `short_account_url`). */
  profileUrl: (identity: InstanceIdentity, username: string): string =>
    `${origin(identity)}/@${username}`,
  /** A local status's page in the web app, its `url` (Mastodon's `short_account_status_url`). */
  statusUrl: (identity: InstanceIdentity, username: string, statusId: string): string =>
    `${origin(identity)}/@${username}/${statusId}`,
  webfingerSubject: (identity: InstanceIdentity, username: string): string =>
    `acct:${username}@${identity.domain}`,
  sharedInboxUrl: (identity: InstanceIdentity): string => `${origin(identity)}/inbox`,
  /** Mastodon's instance actor: the Application that speaks for the server itself. */
  instanceActorUrl: (identity: InstanceIdentity): string => `${origin(identity)}/actor`,
  /**
   * The instance actor's username: the domain, or `mastodon.internal` when
   * the domain has a port, as Mastodon's `Account.representative` renames it,
   * since a username with `:` is not one a remote `Account` takes.
   */
  instanceActorUsername: (identity: InstanceIdentity): string =>
    identity.domain.includes(":") ? "mastodon.internal" : identity.domain,
  webfingerUrl: (identity: InstanceIdentity, username: string): string =>
    `${origin(identity)}/.well-known/webfinger?resource=${encodeURIComponent(
      InstanceIdentity.webfingerSubject(identity, username),
    )}`,
} as const;
