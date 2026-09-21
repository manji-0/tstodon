import { err, ok, type Result } from "neverthrow";
import type { InstanceIdentity } from "@tstodon/domain";

export type FederatedFetchError =
  | Readonly<{ kind: "InvalidSignature" }>
  | Readonly<{ kind: "VerificationUnavailable" }>;

export const isBlockedFederatedHost = (
  hostname: string,
  instanceDomain: string,
): boolean => {
  const host = hostname.toLowerCase();
  if (host === instanceDomain) {
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

export const parseFederatedUrl = (
  value: string,
): Result<URL, FederatedFetchError> => {
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
): Promise<Result<unknown, FederatedFetchError>> => {
  const url = parseFederatedUrl(href);
  if (url.isErr()) {
    return err(url.error);
  }
  if (isBlockedFederatedHost(url.value.hostname, identity.domain)) {
    return err({ kind: "InvalidSignature" });
  }
  try {
    const response = await fetch(url.value, {
      method: "GET",
      headers: {
        Accept:
          'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
        "User-Agent": `tstodon (https://${identity.domain})`,
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
