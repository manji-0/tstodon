import { IpRange } from "./ip-block";

/*
 * Hostname-based SSRF defence: a public hostname may still resolve to an
 * address inside this deployment's network. A federated fetch resolves the
 * host's A/AAAA records first and refuses it when any answer is loopback,
 * private, link-local, shared (CGNAT), multicast or otherwise reserved.
 * Mirrors cfwdon's `remote_hostname_dns_resolution_allowed`.
 */

const blockedRanges = (ranges: ReadonlyArray<string>): ReadonlyArray<IpRange> =>
  ranges.flatMap((range) => {
    const parsed = IpRange.parse(range);
    return parsed.isOk() ? [parsed.value] : [];
  });

/** Ranges a resolved address may not fall in. An IPv4-mapped IPv6 address is matched as IPv4. */
const BLOCKED_RANGES: ReadonlyArray<IpRange> = blockedRanges([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/3",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
]);

/** The verdict on a hostname's resolved addresses. */
export type RemoteDnsVerdict =
  | Readonly<{ kind: "Public" }>
  | Readonly<{ kind: "NoRecords" }>
  | Readonly<{ kind: "BlockedAddress" }>;

/** True when a fetch must not reach the address; a malformed address counts as blocked. */
export const isBlockedResolvedAddress = (address: string): boolean =>
  !IpRange.isAddress(address) || BLOCKED_RANGES.some((range) => IpRange.contains(range, address));

export const RemoteDnsPolicy = {
  /**
   * Judges the A and AAAA answers for a host: no address at all is
   * `NoRecords`, and one blocked address among public ones is
   * `BlockedAddress` (the fetch could connect to any of them).
   */
  judge: (addresses: ReadonlyArray<string>): RemoteDnsVerdict => {
    if (addresses.length === 0) {
      return { kind: "NoRecords" };
    }
    return addresses.some(isBlockedResolvedAddress)
      ? { kind: "BlockedAddress" }
      : { kind: "Public" };
  },
} as const;
