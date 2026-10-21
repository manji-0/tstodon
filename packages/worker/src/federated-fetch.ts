import { err, ok, type Result } from "neverthrow";
import { schemaResult } from "@tstodon/core";
import type { InstanceIdentity } from "@tstodon/domain";
import { RemoteWebfingerSchema } from "./activitypub-wire";

export type FederatedFetchError =
  | Readonly<{ kind: "InvalidSignature" }>
  | Readonly<{ kind: "VerificationUnavailable" }>;

const parseWebfinger = schemaResult(RemoteWebfingerSchema);

export const isBlockedFederatedHost = (
  hostname: string,
  instanceDomain: string,
  allowHosts: ReadonlySet<string> = new Set(),
): boolean => {
  const host = hostname.toLowerCase();
  if (allowHosts.has(host)) {
    return false;
  }
  if (host === instanceDomain.toLowerCase()) {
    return true;
  }
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  ) {
    return true;
  }
  if (host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.")) {
    return true;
  }
  const octets = host.split(".");
  if (octets.length === 4 && octets[0] === "172") {
    const second = Number.parseInt(octets[1] ?? "", 10);
    if (second >= 16 && second <= 31) {
      return true;
    }
  }
  return false;
};

/** Options shared by every outbound federation fetch. */
export type FederatedFetchOptions = Readonly<{
  allowHosts?: ReadonlySet<string>;
  /** Hostnames this instance refuses to talk to (admin-suspended domains). */
  blockedHosts?: ReadonlySet<string>;
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
  const host = hostname.toLowerCase();
  const allowHosts = options.allowHosts;
  if (allowHosts && allowHosts.size > 0 && !allowHosts.has(host)) {
    return true;
  }
  return (
    isBlockedFederatedHost(hostname, instanceDomain, allowHosts) ||
    (options.blockedHosts?.has(host) ?? false)
  );
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
      redirect: "error",
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

/** Resolve a `user@domain` handle to its ActivityPub actor URI via WebFinger. */
export const fetchWebfingerActorUri = async (
  identity: InstanceIdentity,
  handle: string,
  options: FederatedFetchOptions = {},
): Promise<Result<string, FederatedFetchError>> => {
  const trimmed = handle.replace(/^@/, "").trim();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    return err({ kind: "InvalidSignature" });
  }
  const user = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  const resource = `acct:${user}@${domain}`;
  const url = parseFederatedUrl(
    `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`,
  );
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
        Accept: "application/jrd+json, application/json",
        "User-Agent": `tstodon (${identity.publicOrigin})`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status >= 500) {
      return err({ kind: "VerificationUnavailable" });
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
    return ok(self.href);
  } catch {
    return err({ kind: "VerificationUnavailable" });
  }
};
