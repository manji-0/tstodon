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

const NodeInfoSoftware = z.object({ name: z.string().regex(/^[a-z0-9-]+$/), version: z.string() });

/** NodeInfo 2.0 (`/nodeinfo/2.0`). */
export const NodeInfo20 = z.object({
  version: z.literal("2.0"),
  software: NodeInfoSoftware,
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

/** NodeInfo 2.1 (`/nodeinfo/2.1`): 2.0 plus the software's `repository` and `homepage`. */
export const NodeInfo21 = NodeInfo20.extend({
  version: z.literal("2.1"),
  software: NodeInfoSoftware.extend({
    repository: z.string().optional(),
    homepage: z.string().optional(),
  }),
});
export type NodeInfo21JSON = z.infer<typeof NodeInfo21>;
