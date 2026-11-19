import type { WebFingerJrdJSON, WebFingerLinkJSON } from "@tstodon/api/activitypub";
import { InstanceIdentity } from "@tstodon/domain";

/**
 * What a `/.well-known/webfinger?resource=` names on this server, as
 * Mastodon's `WebfingerResource`: `Invalid` answers 400 and `NotFound` 404.
 */
export type WebFingerResource =
  | Readonly<{ kind: "InstanceActor" }>
  | Readonly<{ kind: "Account"; username: string }>
  | Readonly<{ kind: "NotFound" }>
  | Readonly<{ kind: "Invalid" }>;

/** The server's own hosts: the account domain and the web domain (`INSTANCE_PUBLIC_ORIGIN`'s host). */
const localHosts = (identity: InstanceIdentity): ReadonlySet<string> => {
  const web = URL.parse(identity.publicOrigin)?.host.toLowerCase();
  return new Set(web === undefined ? [identity.domain] : [identity.domain, web]);
};

/** `example.com`, `https://example.com/`: the site itself, which names the instance actor. */
const SITE = /^(?:https?:\/\/)?([^/]+)\/?$/i;
const ACCOUNT_PATH = /^\/(?:users\/|@)([^/@]+)\/?$/;

/** A URL on this server names an account by its actor or profile URL, or the instance actor. */
const fromUrl = (hosts: ReadonlySet<string>, resource: string): WebFingerResource => {
  const url = URL.parse(resource);
  // Mastodon matches the path alone; another host's URL names nothing here.
  if (!url || !hosts.has(url.host.toLowerCase())) {
    return { kind: "NotFound" };
  }
  if (url.pathname === "/actor") {
    return { kind: "InstanceActor" };
  }
  const username = ACCOUNT_PATH.exec(url.pathname)?.[1];
  return username === undefined ? { kind: "NotFound" } : { kind: "Account", username };
};

/**
 * `acct:user@domain` or `user@domain`; `<domain>@<domain>` and the instance
 * actor's own username name the instance actor.
 */
const fromAcct = (
  hosts: ReadonlySet<string>,
  instanceActorUsername: string,
  resource: string,
): WebFingerResource => {
  const parts = resource.replace(/^acct:/, "").split("@");
  const username = parts[0] ?? "";
  if (!hosts.has((parts.at(-1) ?? "").toLowerCase())) {
    return { kind: "NotFound" };
  }
  return hosts.has(username.toLowerCase()) || username === instanceActorUsername
    ? { kind: "InstanceActor" }
    : { kind: "Account", username };
};

export const webFingerResource = (
  identity: InstanceIdentity,
  resource: string,
): WebFingerResource => {
  const hosts = localHosts(identity);
  const site = SITE.exec(resource)?.[1];
  if (site !== undefined && hosts.has(site.toLowerCase())) {
    return { kind: "InstanceActor" };
  }
  if (/^https?/i.test(resource)) {
    return fromUrl(hosts, resource);
  }
  return resource.includes("@")
    ? fromAcct(hosts, InstanceIdentity.instanceActorUsername(identity), resource)
    : { kind: "Invalid" };
};

const origin = (identity: InstanceIdentity): string => identity.publicOrigin.replace(/\/$/, "");

/** `/authorize_interaction`, which the `subscribe` and FEP-3b86 `Object` templates open. */
const interactionLinks = (identity: InstanceIdentity): WebFingerLinkJSON[] => [
  {
    rel: "http://ostatus.org/schema/1.0/subscribe",
    template: `${origin(identity)}/authorize_interaction?uri={uri}`,
  },
  { rel: "https://w3id.org/fep/3b86/Create", template: `${origin(identity)}/share?text={content}` },
  {
    rel: "https://w3id.org/fep/3b86/Object",
    template: `${origin(identity)}/authorize_interaction?uri={object}`,
  },
];

/** An avatar Mastodon links: its URL and media type. */
export type WebFingerAvatar = Readonly<{ href: string; type: string }>;

/** Mastodon's `WebfingerSerializer` for a local account. */
export const accountJrd = (
  identity: InstanceIdentity,
  username: string,
  avatar: WebFingerAvatar | undefined,
): WebFingerJrdJSON => {
  const profile = InstanceIdentity.profileUrl(identity, username);
  const actor = InstanceIdentity.actorUrl(identity, username);
  return {
    subject: InstanceIdentity.webfingerSubject(identity, username),
    aliases: [profile, actor],
    links: [
      { rel: "http://webfinger.net/rel/profile-page", type: "text/html", href: profile },
      { rel: "self", type: "application/activity+json", href: actor },
      ...interactionLinks(identity),
      ...(avatar ? [{ rel: "http://webfinger.net/rel/avatar", ...avatar }] : []),
    ],
  };
};

/** Mastodon's `WebfingerSerializer` for the instance actor, whose username is the domain. */
export const instanceActorJrd = (identity: InstanceIdentity): WebFingerJrdJSON => {
  const actor = InstanceIdentity.instanceActorUrl(identity);
  return {
    subject: InstanceIdentity.webfingerSubject(
      identity,
      InstanceIdentity.instanceActorUsername(identity),
    ),
    aliases: [actor],
    links: [
      {
        rel: "http://webfinger.net/rel/profile-page",
        type: "text/html",
        href: `${origin(identity)}/about/more?instance_actor=true`,
      },
      { rel: "self", type: "application/activity+json", href: actor },
      ...interactionLinks(identity),
    ],
  };
};
