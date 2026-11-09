import type {
  NodeInfo20JSON,
  NodeInfoDiscoveryJSON,
  WebFingerJrdJSON,
} from "@tstodon/api/activitypub";
import type { Context } from "hono";
import { InstanceIdentity } from "@tstodon/domain";
import { countAccounts, findAccountByUsername } from "../account-store";
import { jsonRepositoryError } from "../http";
import { parseInstanceIdentity, registrationsOpen } from "../runtime-config";

/** The JRD for an account: its actor as the alias and the `self` link Mastodon resolves. */
const jrd = (subject: string, actorUrl: string): WebFingerJrdJSON => ({
  subject,
  aliases: [actorUrl],
  links: [{ rel: "self", type: "application/activity+json", href: actorUrl }],
});

export const getWellKnownWebfinger = async (
  c: Context<{ Bindings: Env }, "/.well-known/webfinger">,
) => {
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
  // As Mastodon: `acct:<domain>@<domain>` names the instance actor.
  if (username === identity.value.domain) {
    return c.json(jrd(resource, InstanceIdentity.instanceActorUrl(identity.value)));
  }
  const account = await findAccountByUsername(c.env.DB, username);
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ kind: "UnknownResource", resource }, 404);
  }
  return c.json(jrd(resource, InstanceIdentity.actorUrl(identity.value, account.value.username)));
};

export const getWellKnownNodeinfo = (c: Context<{ Bindings: Env }, "/.well-known/nodeinfo">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const discovery: NodeInfoDiscoveryJSON = {
    links: [
      {
        rel: "http://nodeinfo.diaspora.software/ns/schema/2.0",
        href: `${identity.value.publicOrigin.replace(/\/$/, "")}/nodeinfo/2.0`,
      },
    ],
  };
  return c.json(discovery);
};

export const getNodeinfo20 = async (c: Context<{ Bindings: Env }, "/nodeinfo/2.0">) => {
  const users = await countAccounts(c.env.DB);
  const nodeinfo: NodeInfo20JSON = {
    version: "2.0",
    software: { name: "tstodon", version: "0.1.0" },
    protocols: ["activitypub"],
    services: { inbound: [], outbound: [] },
    // As the REST instance's `registrations.enabled` (Mastodon's
    // `registrations_mode != 'none'`).
    openRegistrations: registrationsOpen(c.env),
    usage: { users: { total: users.isOk() ? users.value : 0 } },
    metadata: {},
  };
  return c.json(nodeinfo);
};
