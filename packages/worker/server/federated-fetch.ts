import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { schemaResult, type SensitiveValue } from "@tstodon/core";
import { CoveredHosts, Hostname, type InstanceIdentity } from "@tstodon/domain";
import { RemoteWebfingerSchema } from "./activitypub-wire";
import { linkHeaderAlternate, htmlAlternate } from "./activity-alternate";
import { MAX_FETCHED_BYTES, readBodyJson, readBodyText } from "./body-limit";
import { fetchDoubleKnocking, signFetchRequest } from "./http-signature";
import { hostsExemptFromAddressChecks } from "./federation-allow-hosts";
import { judgeHostDns, type HostDnsVerdict, type HostResolver } from "./remote-dns";

/**
 * Why a federated fetch failed. `VerificationUnavailable` is a server that
 * could not be asked or did not answer; `status` is set when it did answer,
 * with a 5xx, so a caller can tell an error answer from no answer.
 */
export type FederatedFetchError =
  | Readonly<{ kind: "InvalidSignature" }>
  | Readonly<{ kind: "VerificationUnavailable"; status?: number }>;

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
  // An authority with a port (an account domain such as `127.0.0.1:8791`)
  // parses as is; a colon that does not parse is an unbracketed IPv6 literal.
  const parsed =
    URL.parse(`http://${host}/`) ?? (host.startsWith("[") ? null : URL.parse(`http://[${host}]/`));
  return parsed?.hostname.replace(/\.+$/, "");
};

/** True when the list names the host; an IPv6 literal may be listed without brackets. */
const namedIn = (hosts: ReadonlySet<string>, host: string): boolean =>
  hosts.has(host) || hosts.has(host.replace(/^\[(.*)\]$/, "$1"));

/**
 * True when a fetch must not reach the host: this instance itself, an IPv4
 * address in a loopback, private, shared, link-local or reserved block, any
 * IPv6 literal, or a `localhost`, `.internal` or `.local` name, unless
 * `allowHosts` names it. This check is static: a public name that resolves to
 * a private address is caught by `checkFederatedHost`, before a fetch.
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

/** The hosts a federation request may reach. */
export type FederatedHostOptions = Readonly<{
  allowHosts?: ReadonlySet<string>;
  /** Hostnames this instance refuses to talk to (admin-suspended domains). */
  blockedHosts?: CoveredHosts;
  /** Resolves a hostname's addresses for the SSRF check; Cloudflare DoH when omitted. */
  resolveHost?: HostResolver;
}>;

/** The key an ActivityPub GET is signed with (draft-cavage HTTP Signatures). */
export type FetchSigningKey = Readonly<{ keyId: string; privateKeyJwk: SensitiveValue<string> }>;

/**
 * Finds the key to sign ActivityPub GETs with, once per signer; undefined
 * sends them unsigned. `instanceActorFetchSigner` (`server/instance-actor.ts`)
 * signs as the instance actor, as Mastodon does for fetches made on the
 * server's behalf.
 */
export type FetchSigner = () => Promise<FetchSigningKey | undefined>;

/** Sends ActivityPub GETs unsigned: only for tests and code that fetches nothing. */
export const unsignedFetch: FetchSigner = async () => undefined;

/**
 * Options for a fetch of ActivityPub documents. `fetchSigner` is required so
 * that no caller sends an unsigned GET by forgetting it: servers in secure
 * mode (Mastodon's `AUTHORIZED_FETCH`) refuse unsigned GETs.
 */
export type FederatedFetchOptions = FederatedHostOptions & Readonly<{ fetchSigner: FetchSigner }>;

/**
 * True when the host is refused: a non-empty allow list names the only hosts
 * that may federate (limited federation), a private range is refused, or the
 * host is blocked.
 */
export const isFederatedHostRefused = (
  hostname: string,
  instanceDomain: string,
  options: FederatedHostOptions = {},
): boolean =>
  isDomainNotAllowed(hostname, options) ||
  isBlockedFederatedHost(
    hostname,
    instanceDomain,
    hostsExemptFromAddressChecks(options.allowHosts),
  );

/**
 * Mastodon's `domain_not_allowed?`: the host is off a non-empty allow list
 * (limited federation), or a suspension covers it.
 */
export const isDomainNotAllowed = (
  hostname: string,
  options: FederatedHostOptions = {},
): boolean => {
  const allowHosts = options.allowHosts;
  const host = urlHostname(hostname);
  if (allowHosts && allowHosts.size > 0 && (host === undefined || !namedIn(allowHosts, host))) {
    return true;
  }
  return CoveredHosts.covers(
    options.blockedHosts ?? CoveredHosts.none,
    Hostname.ofAuthority(hostname),
  );
};

/**
 * Whether a fetch may reach the host: `isFederatedHostRefused`, then, for a
 * name (not an IP literal, not one `allowHosts` names), its DNS answers. A
 * host resolving to a private or reserved address, or to nothing, is
 * `Refused`; a lookup that failed is `Unavailable`, so the caller can retry.
 */
export const checkFederatedHost = async (
  hostname: string,
  instanceDomain: string,
  options: FederatedHostOptions = {},
): Promise<HostDnsVerdict> => {
  if (isFederatedHostRefused(hostname, instanceDomain, options)) {
    return "Refused";
  }
  const host = urlHostname(hostname);
  if (
    host === undefined ||
    host.startsWith("[") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    namedIn(hostsExemptFromAddressChecks(options.allowHosts), host)
  ) {
    return "Admitted";
  }
  return judgeHostDns(host, options.resolveHost);
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

/** What an ActivityPub GET asks for, as Mastodon's `fetch_resource` (and signs, in `accept`). */
export const ACTIVITY_JSON_ACCEPT =
  'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

/**
 * What a URL lookup asks for, as Mastodon's `FetchResourceService`: an
 * ActivityPub document, or else a page that may link to one.
 */
const RESOURCE_ACCEPT = `${ACTIVITY_JSON_ACCEPT}, text/html;q=0.1`;

/** Redirects an ActivityPub GET follows, as Mastodon's `Request` (`max_hops: 3`); same origin only. */
const ACTIVITY_MAX_REDIRECTS = 3;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * One ActivityPub GET, not following redirects: signed for this URL (its
 * path, query and host are in the signature) when the signer has a key,
 * draft-cavage first and RFC 9421 when that is answered 400 or 401, as
 * Mastodon's `Request#perform`; unsigned when it has no key or signing
 * fails (a server outside secure mode still answers). `signal` gives the
 * signal of each request sent: its own deadline, or one a caller shares.
 */
const getActivityOnce = async (
  identity: InstanceIdentity,
  url: URL,
  key: FetchSigningKey | undefined,
  signal: () => AbortSignal,
  accept: string = ACTIVITY_JSON_ACCEPT,
): Promise<Response> => {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": `tstodon (${identity.publicOrigin})`,
  };
  const send = (signed: Readonly<Record<string, string>>): Promise<Response> =>
    fetch(url, {
      method: "GET",
      headers: { ...headers, ...signed },
      redirect: "manual",
      signal: signal(),
    });
  if (key === undefined) {
    return send({});
  }
  const sent = await fetchDoubleKnocking(
    (scheme) => signFetchRequest(url, key.privateKeyJwk, key.keyId, accept, new Date(), scheme),
    send,
  );
  if (sent.isErr()) {
    console.error(JSON.stringify({ kind: "FetchNotSigned", message: sent.error.message }));
    return send({});
  }
  return sent.value;
};

/**
 * Whether `href`'s own server says it is gone: a signed GET of it, under the
 * same host guard as {@link fetchActivityJson}, answered 404 or 410 without
 * a redirect. Anything else (a document, a redirect, another status, a
 * refused host, no answer) is not proof that it is gone.
 */
export const answersGone = async (
  identity: InstanceIdentity,
  href: string,
  options: FederatedFetchOptions,
): Promise<boolean> => {
  const url = parseFederatedUrl(href);
  if (url.isErr()) {
    return false;
  }
  try {
    if ((await checkFederatedHost(url.value.hostname, identity.domain, options)) !== "Admitted") {
      return false;
    }
    const key = await options.fetchSigner();
    const response = await getActivityOnce(identity, url.value, key, () =>
      AbortSignal.timeout(5000),
    );
    await response.body?.cancel();
    return response.status === 404 || response.status === 410;
  } catch {
    return false;
  }
};

/**
 * GET an ActivityPub URL, signed by `options.fetchSigner`, and answer its
 * successful response with the body unread. Up to three redirects are
 * followed when they stay on the same origin (scheme, host and port), each
 * hop signed again for its own request target and checked against the host
 * guard and DNS first; a redirect to another origin is refused, as the
 * document's authority would change. One 5 s deadline covers the chain and
 * the body's read, and a URL already fetched is not fetched again.
 */
const getActivity = async (
  identity: InstanceIdentity,
  href: string,
  options: FederatedFetchOptions,
  accept: string,
): Promise<Result<Response, FederatedFetchError>> => {
  const first = parseFederatedUrl(href);
  if (first.isErr()) {
    return err(first.error);
  }
  try {
    const key = await options.fetchSigner();
    const signal = AbortSignal.timeout(5000);
    const fetched = new Set<string>();
    let url = first.value;
    for (let redirects = 0; ; redirects += 1) {
      const admitted = await checkFederatedHost(url.hostname, identity.domain, options);
      if (admitted !== "Admitted") {
        return err({
          kind: admitted === "Refused" ? "InvalidSignature" : "VerificationUnavailable",
        });
      }
      fetched.add(url.href);
      // Workers' fetch would follow redirects unsigned and past the host
      // guard, and rejects `redirect: "error"` outright, so each hop is
      // followed here.
      const response = await getActivityOnce(identity, url, key, () => signal, accept);
      const location = response.headers.get("location");
      if (REDIRECT_STATUSES.has(response.status) && location !== null) {
        await response.body?.cancel();
        const next = URL.parse(location, url.href);
        if (
          redirects === ACTIVITY_MAX_REDIRECTS ||
          next === null ||
          next.origin !== first.value.origin ||
          fetched.has(next.href.replace(/#.*$/, ""))
        ) {
          return err({ kind: "InvalidSignature" });
        }
        next.hash = "";
        url = next;
        continue;
      }
      if (response.status >= 500) {
        return err({ kind: "VerificationUnavailable", status: response.status });
      }
      if (!response.ok) {
        await response.body?.cancel();
        return err({ kind: "InvalidSignature" });
      }
      return ok(response);
    }
  } catch {
    return err({ kind: "VerificationUnavailable" });
  }
};

const readDocument = async (response: Response): Promise<Result<unknown, FederatedFetchError>> => {
  try {
    const document = await readBodyJson(response, MAX_FETCHED_BYTES);
    return document.isOk() ? ok(document.value) : err({ kind: "InvalidSignature" });
  } catch {
    return err({ kind: "VerificationUnavailable" });
  }
};

/** GET an ActivityPub document (see {@link getActivity}) and read it as JSON. */
export const fetchActivityJson = async (
  identity: InstanceIdentity,
  href: string,
  options: FederatedFetchOptions,
): Promise<Result<unknown, FederatedFetchError>> => {
  const response = await getActivity(identity, href, options, ACTIVITY_JSON_ACCEPT);
  return response.isOk() ? readDocument(response.value) : err(response.error);
};

/** A JSON-LD context as fetched: its body, and that body read. */
export type FetchedJsonLdContext = Readonly<{
  json: string;
  document: Readonly<Record<string, unknown>>;
}>;

/**
 * GET a JSON-LD context a document names, as Mastodon's
 * `load_jsonld_context`: unsigned (`Request.new(:get, url)`, no
 * `on_behalf_of`), asking for `application/ld+json`, and taken only from a
 * 200 answered as `application/ld+json`, up to 1 MiB (`body_with_limit`).
 * The host guard, deadline and same-origin redirects are
 * {@link fetchActivityJson}'s. A body that is not a JSON object is refused.
 */
export const fetchJsonLdContext = async (
  identity: InstanceIdentity,
  href: string,
  options: FederatedHostOptions,
): Promise<Result<FetchedJsonLdContext, FederatedFetchError>> => {
  const response = await getActivity(
    identity,
    href,
    { ...options, fetchSigner: unsignedFetch },
    "application/ld+json",
  );
  if (response.isErr()) {
    return err(response.error);
  }
  const mediaType = (response.value.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (response.value.status !== 200 || mediaType !== "application/ld+json") {
    await response.value.body?.cancel();
    return err({ kind: "InvalidSignature" });
  }
  try {
    const json = await readBodyText(response.value, MAX_FETCHED_BYTES);
    if (json.isErr()) {
      return err({ kind: "InvalidSignature" });
    }
    const document = parseJsonObject(JSON.parse(json.value));
    return document.isOk()
      ? ok({ json: json.value, document: document.value })
      : err({ kind: "InvalidSignature" });
  } catch {
    return err({ kind: "VerificationUnavailable" });
  }
};

const parseJsonObject = schemaResult(z.record(z.string(), z.unknown()));

/**
 * What a URL serves for a lookup: its ActivityPub document, or the URL of
 * the document a page names (`Alternate`), or neither.
 */
export type FetchedResource =
  | Readonly<{ kind: "Document"; document: unknown }>
  | Readonly<{ kind: "Alternate"; href: string }>
  | Readonly<{ kind: "None" }>;

const ACTIVITY_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/activity+json",
  "application/ld+json",
]);

/**
 * GET a URL a lookup names, as Mastodon's `FetchResourceService` does
 * (`RESOURCE_ACCEPT`): an ActivityPub media type is the document; otherwise
 * the `Link` header's `alternate`, else an HTML page's `<link
 * rel="alternate">`, names the document, which the caller fetches in turn.
 * The page is read up to `MAX_FETCHED_BYTES`. Any other body is read as
 * JSON, as {@link fetchActivityJson} reads it.
 */
export const fetchActivityResource = async (
  identity: InstanceIdentity,
  href: string,
  options: FederatedFetchOptions,
): Promise<Result<FetchedResource, FederatedFetchError>> => {
  const response = await getActivity(identity, href, options, RESOURCE_ACCEPT);
  if (response.isErr()) {
    return err(response.error);
  }
  const mediaType = (response.value.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (mediaType === undefined || !ACTIVITY_MEDIA_TYPES.has(mediaType)) {
    const linked = linkHeaderAlternate(response.value.headers.get("link"));
    if (linked !== undefined) {
      await response.value.body?.cancel();
      return ok({ kind: "Alternate", href: linked });
    }
    if (mediaType === "text/html") {
      try {
        const page = await readBodyText(response.value, MAX_FETCHED_BYTES);
        const alternate = page.isOk() ? await htmlAlternate(page.value) : undefined;
        return ok(
          alternate === undefined ? { kind: "None" } : { kind: "Alternate", href: alternate },
        );
      } catch {
        return err({ kind: "VerificationUnavailable" });
      }
    }
  }
  return (await readDocument(response.value)).map((document): FetchedResource => ({
    kind: "Document",
    document,
  }));
};

/** A WebFinger answer: the account it names and its ActivityPub actor URI. */
export type WebfingerAnswer = Readonly<{ subject: string | undefined; self: string }>;

/** Redirects a WebFinger lookup follows, as Mastodon's `Request` (`max_hops: 3`). */
const WEBFINGER_MAX_REDIRECTS = 3;

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
  options: FederatedHostOptions,
): Promise<Result<Response, FederatedFetchError>> => {
  const signal = AbortSignal.timeout(5000);
  const fetched = new Set<string>();
  let url = first;
  for (let redirects = 0; ; redirects += 1) {
    if (
      fetched.has(url.href) ||
      url.protocol !==
        `${webfingerScheme(url.hostname, hostsExemptFromAddressChecks(options.allowHosts))}:`
    ) {
      return err({ kind: "InvalidSignature" });
    }
    const admitted = await checkFederatedHost(url.hostname, identity.domain, options);
    if (admitted !== "Admitted") {
      return err({ kind: admitted === "Refused" ? "InvalidSignature" : "VerificationUnavailable" });
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

/**
 * Look up a `user@domain` handle by WebFinger. Unsigned, as Mastodon's
 * `Webfinger` sends it (no `on_behalf_of`); secure mode leaves WebFinger open.
 */
export const fetchWebfinger = async (
  identity: InstanceIdentity,
  handle: string,
  options: FederatedHostOptions = {},
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
    `${webfingerScheme(host, hostsExemptFromAddressChecks(options.allowHosts))}://${domain}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`,
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
    const document = await readBodyJson(response, MAX_FETCHED_BYTES);
    if (document.isErr()) {
      return err({ kind: "InvalidSignature" });
    }
    const parsed = parseWebfinger(document.value);
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
