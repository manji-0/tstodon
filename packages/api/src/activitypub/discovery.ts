import { z } from "zod";
import { ApUri } from "./context";

/** A WebFinger link (RFC 7033). */
export const WebFingerLink = z.object({
  rel: z.string(),
  type: z.string().optional(),
  href: ApUri.optional(),
  template: z.string().optional(),
});
export type WebFingerLinkJSON = z.infer<typeof WebFingerLink>;

/**
 * The JRD `/.well-known/webfinger` answers for `acct:user@domain`: the
 * account's actor as `aliases` and the `self` link Mastodon resolves.
 */
export const WebFingerJrd = z.object({
  subject: z.string().startsWith("acct:"),
  aliases: z.array(ApUri),
  links: z.array(WebFingerLink),
});
export type WebFingerJrdJSON = z.infer<typeof WebFingerJrd>;

/** `/.well-known/nodeinfo`: where the NodeInfo documents are. */
export const NodeInfoDiscovery = z.object({
  links: z.array(z.object({ rel: ApUri, href: ApUri })),
});
export type NodeInfoDiscoveryJSON = z.infer<typeof NodeInfoDiscovery>;

/** NodeInfo 2.0 (`/nodeinfo/2.0`). */
export const NodeInfo20 = z.object({
  version: z.literal("2.0"),
  software: z.object({ name: z.string().regex(/^[a-z0-9-]+$/), version: z.string() }),
  protocols: z.array(z.literal("activitypub")),
  services: z.object({ inbound: z.array(z.string()), outbound: z.array(z.string()) }),
  openRegistrations: z.boolean(),
  usage: z.object({
    users: z.object({
      total: z.number().int().nonnegative().optional(),
      activeMonth: z.number().int().nonnegative().optional(),
      activeHalfyear: z.number().int().nonnegative().optional(),
    }),
    localPosts: z.number().int().nonnegative().optional(),
  }),
  metadata: z.record(z.string(), z.unknown()),
});
export type NodeInfo20JSON = z.infer<typeof NodeInfo20>;
