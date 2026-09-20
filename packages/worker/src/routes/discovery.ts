import { InstanceIdentity } from "@tstodon/domain";
import { Hono } from "hono";
import { parseInstanceIdentity } from "../runtime-config";

export const discoveryRoutes = new Hono<{ Bindings: Env }>();

discoveryRoutes.get("/.well-known/webfinger", (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const resource = c.req.query("resource");
  if (!resource) {
    return c.json({ kind: "MissingResource" }, 400);
  }
  const prefix = `acct:`;
  const suffix = `@${identity.value.domain}`;
  if (!resource.startsWith(prefix) || !resource.endsWith(suffix)) {
    return c.json({ kind: "UnknownResource", resource }, 404);
  }
  const username = resource.slice(prefix.length, resource.length - suffix.length);
  const actorUrl = InstanceIdentity.actorUrl(identity.value, username);
  return c.json({
    subject: resource,
    aliases: [actorUrl],
    links: [
      {
        rel: "self",
        type: "application/activity+json",
        href: actorUrl,
      },
    ],
  });
});

discoveryRoutes.get("/.well-known/nodeinfo", (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  return c.json({
    links: [
      {
        rel: "http://nodeinfo.diaspora.software/ns/schema/2.0",
        href: `https://${identity.value.domain}/nodeinfo/2.0`,
      },
    ],
  });
});

discoveryRoutes.get("/nodeinfo/2.0", (c) =>
  c.json({
    version: "2.0",
    software: { name: "tstodon", version: "0.1.0" },
    protocols: ["activitypub"],
    services: { inbound: [], outbound: [] },
    openRegistrations: false,
    usage: { users: { total: 0 } },
    metadata: {},
  }),
);
