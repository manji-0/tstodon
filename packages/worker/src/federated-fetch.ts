import { err, ok, type Result } from "neverthrow";
import { schemaResult } from "@tstodon/core";
import { Hostname, type InstanceIdentity } from "@tstodon/domain";
import { RemoteWebfingerSchema } from "./activitypub-wire";

export type FederatedFetchError =
  | Readonly<{ kind: "InvalidSignature" }>
  | Readonly<{ kind: "VerificationUnavailable" }>;

/** A WebFinger lookup's failure; `NoSuchAccount` is a 404 or 410, the server's definite "no". */
export type WebfingerFetchError = FederatedFetchError | Readonly<{ kind: "NoSuchAccount" }>;

const parseWebfinger = schemaResult(RemoteWebfingerSchema);

/** IPv4 blocks no federated fetch may reach: `[network, prefix length]`. */
const REFUSED_IPV4_BLOCKS: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 3],
];

const PRIVATE_NAME_SUFFIXES: ReadonlyArray<string> = ["localhost", "internal", "local"];

const ipv4Number = (address: string): number =>
  address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);

const inIpv4Block = (address: number, [network, prefix]: readonly [string, number]): boolean => {
  const size = 2 ** (32 - prefix);
  return Math.floor(address / size) === Math.floor(ipv4Number(network) / size);
};

/**
 * The host as a URL would name it: lower case, no trailing dot, IPv4 in
 * dotted decimal whatever form it was written in (`2130706433`, `0x7f.1`,
 * `0177.0.0.1`), IPv6 in brackets. Undefined when no URL could name it.
 */
const urlHostname = (hostname: string): string | undefined => {
  const host = hostname.trim().toLowerCase().replace(/\.+$/, "");
  const literal = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return URL.parse(`http://${literal}/`)?.hostname.replace(/\.+$/, "");
};

/** True when the list names the host; an IPv6 literal may be listed without brackets. */
const namedIn = (hosts: ReadonlySet<string>, host: string): boolean =>
  hosts.has(host) || hosts.has(host.replace(/^\[(.*)\]$/, "$1"));

/**
 * True when a fetch must not reach the host: this instance itself, an IPv4
 * address in a loopback, private, shared, link-local or reserved block, any
 * IPv6 literal, or a `localhost`, `.internal` or `.local` name, unless
 * `allowHosts` names it. Workers cannot see what a name resolves to, so a
 * public name that resolves to a private address is not caught here.
 */
export const isBlockedFederatedHost = (
  hostname: string,
  instanceDomain: string,
  allowHosts: ReadonlySet<string> = new Set(),
): boolean => {
  const host = urlHostname(hostname);
  if (host === undefined) {
    return true;
  }
  if (namedIn(allowHosts, host)) {
    return false;
  }
  if (host === urlHostname(Hostname.ofAuthority(instanceDomain)) || host.startsWith("[")) {
    return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const address = ipv4Number(host);
    return REFUSED_IPV4_BLOCKS.some((block) => inIpv4Block(address, block));
  }
  return PRIVATE_NAME_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
};

/** Options shared by every outbound federation fetch. */
export type FederatedFetchOptions = Readonly<{
  allowHosts?: ReadonlySet<string>;
  /** Hostnames this instance refuses to talk to (admin-suspended domains). */
  blockedHosts?: ReadonlySet<Hostname>;
}>;

/**
 * True when the host is refused: a non-empty allow list names the only hosts
 * that may federate (limited federation), a private range is refused, or the
 * host is blocked.
 */
export const isFederatedHostRefused = (
  hostname: string,
  instanceDomain: string,
  options: FederatedFetchOptions = {},
): boolean => {
  const allowHosts = options.allowHosts;
  const host = urlHostname(hostname);
  if (allowHosts && allowHosts.size > 0 && (host === undefined || !namedIn(allowHosts, host))) {
    return true;
  }
  return (
    isBlockedFederatedHost(hostname, instanceDomain, allowHosts) ||
    (options.blockedHosts?.has(Hostname.ofAuthority(hostname)) ?? false)
  );
};

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * WebFinger is fetched over HTTPS, except from a loopback host the operator
 * named in `FEDERATION_ALLOW_HOSTS`: local test servers (the e2e suites) speak
 * plain HTTP, and only an explicit allow-list entry exempts them at all.
 */
export const webfingerScheme = (
  hostname: string,
  allowHosts: ReadonlySet<string> = new Set(),
): "http" | "https" => {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) && allowHosts.has(host) ? "http" : "https";
};

export const parseFederatedUrl = (value: string): Result<URL, FederatedFetchError> => {
  try {
    const url = new URL(value);
    url.hash = "";
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return err({ kind: "InvalidSignature" });
    }
    return ok(url);
  } catch {
    return err({ kind: "InvalidSignature" });
  }
};

export const fetchActivityJson = async (
  identity: InstanceIdentity,
  href: string,
  options: FederatedFetchOptions = {},
): Promise<Result<unknown, FederatedFetchError>> => {
  const url = parseFederatedUrl(href);
  if (url.isErr()) {
    return err(url.error);
  }
  if (isFederatedHostRefused(url.value.hostname, identity.domain, options)) {
    return err({ kind: "InvalidSignature" });
  }
  try {
    const response = await fetch(url.value, {
      method: "GET",
      headers: {
        Accept:
          'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
        "User-Agent": `tstodon (${identity.publicOrigin})`,
      },
      // Redirects are refused (a 3xx is not `ok` below). Workers' fetch
      // rejects `redirect: "error"` outright, so it must be "manual".
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status >= 500) {
      return err({ kind: "VerificationUnavailable" });
    }
    if (!response.ok) {
      return err({ kind: "InvalidSignature" });
    }
    return ok(await response.json());
  } catch {
    return err({ kind: "VerificationUnavailable" });
  }
};

/** A WebFinger answer: the account it names and its ActivityPub actor URI. */
export type WebfingerAnswer = Readonly<{ subject: string | undefined; self: string }>;

/** Redirects a WebFinger lookup follows, as Mastodon's `Request` (`max_hops: 3`). */
const WEBFINGER_MAX_REDIRECTS = 3;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * GET a WebFinger URL, following up to three redirects, as a split-domain
 * server (Mastodon's `LOCAL_DOMAIN` / `WEB_DOMAIN`) redirects its account
 * domain's WebFinger to its own host. Every hop passes the same host guard
 * and scheme rule as the first, a URL already fetched is not fetched again,
 * and one 5 s deadline covers the whole chain. The answer still speaks for
 * the domain first asked, which chose where to redirect.
 */
const followWebfingerRedirects = async (
  identity: InstanceIdentity,
  first: URL,
  options: FederatedFetchOptions,
): Promise<Result<Response, FederatedFetchError>> => {
  const signal = AbortSignal.timeout(5000);
  const fetched = new Set<string>();
  let url = first;
  for (let redirects = 0; ; redirects += 1) {
    if (
      fetched.has(url.href) ||
      url.protocol !== `${webfingerScheme(url.hostname, options.allowHosts)}:` ||
      isFederatedHostRefused(url.hostname, identity.domain, options)
    ) {
      return err({ kind: "InvalidSignature" });
    }
    fetched.add(url.href);
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/jrd+json, application/json",
        "User-Agent": `tstodon (${identity.publicOrigin})`,
      },
      // Workers' fetch would follow redirects past the host guard, and
      // rejects `redirect: "error"` outright, so each hop is followed here.
      redirect: "manual",
      signal,
    });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || location === null) {
      return ok(response);
    }
    await response.body?.cancel();
    if (redirects === WEBFINGER_MAX_REDIRECTS) {
      return err({ kind: "InvalidSignature" });
    }
    const next = URL.parse(location, url.href);
    if (next === null) {
      return err({ kind: "InvalidSignature" });
    }
    next.hash = "";
    url = next;
  }
};

/** Look up a `user@domain` handle by WebFinger. */
export const fetchWebfinger = async (
  identity: InstanceIdentity,
  handle: string,
  options: FederatedFetchOptions = {},
): Promise<Result<WebfingerAnswer, WebfingerFetchError>> => {
  const trimmed = handle.replace(/^@/, "").trim();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    return err({ kind: "InvalidSignature" });
  }
  const user = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  const resource = `acct:${user}@${domain}`;
  const host = domain.replace(/:\d+$/, "");
  const url = parseFederatedUrl(
    `${webfingerScheme(host, options.allowHosts)}://${domain}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`,
  );
  if (url.isErr()) {
    return err(url.error);
  }
  try {
    const followed = await followWebfingerRedirects(identity, url.value, options);
    if (followed.isErr()) {
      return err(followed.error);
    }
    const response = followed.value;
    if (response.status >= 500) {
      return err({ kind: "VerificationUnavailable" });
    }
    if (response.status === 404 || response.status === 410) {
      return err({ kind: "NoSuchAccount" });
    }
    if (!response.ok) {
      return err({ kind: "InvalidSignature" });
    }
    const parsed = parseWebfinger(await response.json());
    if (parsed.isErr()) {
      return err({ kind: "InvalidSignature" });
    }
    const self = parsed.value.links?.find(
      (link) =>
        link.rel === "self" &&
        link.href !== undefined &&
        (link.type === "application/activity+json" ||
          link.type === 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"'),
    );
    if (!self?.href) {
      return err({ kind: "InvalidSignature" });
    }
    return ok({ subject: parsed.value.subject, self: self.href });
  } catch {
    return err({ kind: "VerificationUnavailable" });
  }
};
