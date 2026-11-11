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

/** Served by `app/middleware/03.well-known.ts` (no route file: Void skips dot directories). */
export const getWellKnownWebfinger = async (c: Context<{ Bindings: Env }>) => {
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

const webfingerTemplate = (publicOrigin: string): string =>
  `${publicOrigin.replace(/\/$/, "")}/.well-known/webfinger?resource={uri}`;

const escapeXmlAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const HOST_META_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=1500";

/** RFC 6415 host-meta (XRD) with the LRDD WebFinger template, as Mastodon serves it. */
export const getWellKnownHostMeta = (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const template = escapeXmlAttribute(webfingerTemplate(identity.value.publicOrigin));
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">\n' +
    `  <Link rel="lrdd" template="${template}"/>\n` +
    "</XRD>\n";
  return c.body(body, 200, {
    "Content-Type": "application/xrd+xml; charset=utf-8",
    "Cache-Control": HOST_META_CACHE_CONTROL,
  });
};

/** The same host-meta as a JRD (`/.well-known/host-meta.json`). */
export const getWellKnownHostMetaJson = (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  return c.body(
    JSON.stringify({
      links: [{ rel: "lrdd", template: webfingerTemplate(identity.value.publicOrigin) }],
    }),
    200,
    { "Content-Type": "application/jrd+json", "Cache-Control": HOST_META_CACHE_CONTROL },
  );
};

export const getWellKnownNodeinfo = (c: Context<{ Bindings: Env }>) => {
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
