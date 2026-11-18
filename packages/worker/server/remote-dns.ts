import { IpRange, RemoteDnsPolicy } from "@tstodon/domain";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";

/*
 * Hostname-based SSRF defence for federated fetches. Workers' `fetch` resolves
 * names on its own, so tstodon resolves A and AAAA records over
 * DNS-over-HTTPS first (Cloudflare's resolver, as cfwdon does) and refuses a
 * host with any private or reserved answer. It is best-effort filtering, not IP
 * pinning: the later `fetch` resolves again.
 */

/** What a host's DNS lookup came to. */
export type HostResolution =
  | Readonly<{ kind: "Resolved"; addresses: ReadonlyArray<string> }>
  /** DNS answered with an error status: NXDOMAIN (3), SERVFAIL (2), ... */
  | Readonly<{ kind: "DnsError"; status: number }>
  /** The resolver could not be asked (network, HTTP error, unreadable answer). */
  | Readonly<{ kind: "Failed" }>;

/** Resolves a hostname's A and AAAA records. Never throws. */
export type HostResolver = (host: string) => Promise<HostResolution>;

/**
 * The verdict on a hostname: admitted, refused, not decidable now because
 * the resolver could not be asked (`Unavailable`, this server's failure), or
 * not resolvable because DNS answered with an error (`Unresolvable`, the
 * remote's: a fetch would fail the same way). Both of the last two retry.
 */
export type HostDnsVerdict = "Admitted" | "Refused" | "Unavailable" | "Unresolvable";

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 3000;

/** How long an isolate remembers a verdict, allowed or refused (cfwdon's `DOH_L1_TTL_MS`). */
export const DNS_VERDICT_TTL_MS = 60_000;
const DNS_VERDICT_CACHE_LIMIT = 1000;

const DohResponseSchema = z.object({
  Status: z.number(),
  Answer: z.array(z.object({ data: z.string() })).optional(),
});
const parseDohResponse = schemaResult(DohResponseSchema);

const queryDoh = async (host: string, type: "A" | "AAAA"): Promise<HostResolution> => {
  try {
    const response = await fetch(`${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: "Failed" };
    }
    const body = parseDohResponse(await response.json());
    if (body.isErr()) {
      return { kind: "Failed" };
    }
    if (body.value.Status !== 0) {
      return { kind: "DnsError", status: body.value.Status };
    }
    // CNAME answers carry names, not addresses; they are not addresses to judge.
    const addresses = (body.value.Answer ?? []).map((a) => a.data).filter(IpRange.isAddress);
    return { kind: "Resolved", addresses };
  } catch {
    return { kind: "Failed" };
  }
};

/**
 * Cloudflare DNS-over-HTTPS: A and AAAA in parallel. Either query that could
 * not be made fails the lookup; otherwise a DNS error on either is the answer.
 */
export const dohHostResolver: HostResolver = async (host) => {
  const [a, aaaa] = await Promise.all([queryDoh(host, "A"), queryDoh(host, "AAAA")]);
  if (a.kind === "Failed" || aaaa.kind === "Failed") {
    return { kind: "Failed" };
  }
  if (a.kind === "DnsError") {
    return a;
  }
  if (aaaa.kind === "DnsError") {
    return aaaa;
  }
  return { kind: "Resolved", addresses: [...a.addresses, ...aaaa.addresses] };
};

const verdicts = new Map<
  string,
  Readonly<{ verdict: "Admitted" | "Refused"; expiresAt: number }>
>();

/**
 * The resolver a fetch uses when it names none. It lives on `globalThis`
 * because the test runner's module graph and the built Worker's are separate
 * copies of this module in one isolate, and a test's stub must reach both.
 */
const RESOLVER_SLOT = Symbol.for("tstodon.defaultHostResolver");

const ResolverSlotSchema = z.custom<HostResolver>((value) => typeof value === "function");

const defaultResolver = (): HostResolver => {
  const slot = ResolverSlotSchema.safeParse(Reflect.get(globalThis, RESOLVER_SLOT));
  return slot.success ? slot.data : dohHostResolver;
};

/** Replaces the resolver used when a fetch names none: for tests, which must not reach the network. */
export const setDefaultHostResolver = (resolver: HostResolver): void => {
  Reflect.set(globalThis, RESOLVER_SLOT, resolver);
};

const remember = (host: string, verdict: "Admitted" | "Refused", now: number): void => {
  for (const [key, entry] of verdicts) {
    if (entry.expiresAt <= now) {
      verdicts.delete(key);
    }
  }
  if (verdicts.size >= DNS_VERDICT_CACHE_LIMIT) {
    verdicts.clear();
  }
  verdicts.set(host, { verdict, expiresAt: now + DNS_VERDICT_TTL_MS });
};

/**
 * Whether a fetch may reach the hostname, judged by its DNS answers. Fails
 * closed: a failed lookup is `Unavailable` and no records is `Refused`. As in
 * cfwdon, only definite verdicts are cached (a transient failure or an empty
 * answer can recover at once). An isolate cache serves repeat lookups; tstodon
 * has no KV binding to share one across isolates.
 */
export const judgeHostDns = async (
  hostname: string,
  resolver: HostResolver = defaultResolver(),
  now: () => number = Date.now,
): Promise<HostDnsVerdict> => {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  const cached = verdicts.get(host);
  if (cached !== undefined && cached.expiresAt > now()) {
    return cached.verdict;
  }
  const resolution = await resolver(host);
  if (resolution.kind === "Failed") {
    return "Unavailable";
  }
  if (resolution.kind === "DnsError") {
    return "Unresolvable";
  }
  const verdict = RemoteDnsPolicy.judge(resolution.addresses);
  switch (verdict.kind) {
    case "Public":
      remember(host, "Admitted", now());
      return "Admitted";
    case "BlockedAddress":
      remember(host, "Refused", now());
      return "Refused";
    case "NoRecords":
      return "Refused";
  }
};

/** Clears the isolate cache: for tests. */
export const clearDnsVerdictCache = (): void => verdicts.clear();
