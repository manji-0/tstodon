import { InstanceIdentity } from "@tstodon/domain";
import { Hono } from "hono";
import { countAccounts, findAccountByUsername } from "../account-store";
import { jsonRepositoryError } from "../http";
import { parseInstanceIdentity } from "../runtime-config";

export const discoveryRoutes = new Hono<{ Bindings: Env }>();

discoveryRoutes.get("/.well-known/webfinger", async (c) => {
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
  const account = await findAccountByUsername(c.env.DB, username);
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ kind: "UnknownResource", resource }, 404);
  }
  const actorUrl = InstanceIdentity.actorUrl(identity.value, account.value.username);
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
        href: `${identity.value.publicOrigin.replace(/\/$/, "")}/nodeinfo/2.0`,
      },
    ],
  });
});

discoveryRoutes.get("/nodeinfo/2.0", async (c) => {
  const users = await countAccounts(c.env.DB);
  return c.json({
    version: "2.0",
    software: { name: "tstodon", version: "0.1.0" },
    protocols: ["activitypub"],
    services: { inbound: [], outbound: [] },
    openRegistrations: false,
    usage: { users: { total: users.isOk() ? users.value : 0 } },
    metadata: {},
  });
});
