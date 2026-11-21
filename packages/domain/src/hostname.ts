import { z } from "zod";

export const HostnameBrand = Symbol("Hostname");

/**
 * A lower-case hostname without a port: what domain blocks, suspensions and
 * an account's domain blocks name. A remote actor's `domain` is its authority,
 * `host[:port]`, so it must pass through `ofAuthority` before it meets a block;
 * a rule on `peer.test` then covers `peer.test:8792` too. A fully qualified
 * `peer.test.` is the same host, so its trailing dot is dropped.
 */
const schema = z.string().brand<typeof HostnameBrand>();

export type Hostname = z.infer<typeof schema>;

const withoutTrailingDots = (host: string): string => host.replace(/\.+$/, "");

/**
 * An internationalized name in its ASCII (punycode) form, as Addressable's
 * `normalized_host`. A name with URL syntax in it stays as it is, as an ASCII
 * one does, so `DomainValidator` refuses it rather than the URL parser
 * reading a host out of it. The conversion maps `。` to `.`, so a trailing
 * one is dropped after it.
 */
const asciiHost = (host: Hostname): Hostname => {
  if (!/[^\x00-\x7f]/.test(host) || /[@?#\\/:]/.test(host)) {
    return host;
  }
  try {
    return schema.parse(withoutTrailingDots(new URL(`http://${host}`).hostname));
  } catch {
    return host;
  }
};

const MAX_DOMAIN_LENGTH = 256;
const DOMAIN_LABEL = /^[a-z0-9-]{1,63}$/;

const ofAuthority = (authority: string): Hostname => {
  const lower = authority.toLowerCase();
  if (lower.startsWith("[")) {
    return schema.parse(lower.slice(0, lower.indexOf("]") + 1));
  }
  const colon = lower.indexOf(":");
  return schema.parse(withoutTrailingDots(colon < 0 ? lower : lower.slice(0, colon)));
};

export const Hostname = {
  schema,
  /** The hostname of a `host[:port]` authority, such as `RemoteActor.domain`. */
  ofAuthority,
  /**
   * A domain as a person types it: scheme, path, a leading `@` and the port
   * dropped, an internationalized name in its ASCII form. `undefined` when
   * nothing is left.
   */
  fromInput: (raw: string): Hostname | undefined => {
    const host = ofAuthority(
      raw
        .trim()
        .replace(/^@/, "")
        .replace(/^https?:\/\//i, "")
        .replace(/\/.*$/, ""),
    );
    return host.length > 0 ? asciiHost(host) : undefined;
  },
  /** Whether Mastodon's `DomainValidator` accepts the name a domain block or allow stores. */
  isValidDomain: (host: Hostname): boolean =>
    host.length < MAX_DOMAIN_LENGTH && host.split(".").every((label) => DOMAIN_LABEL.test(label)),
  /**
   * The host and each domain above it, most specific first: Mastodon's
   * `domain_variants`, which `DomainBlock.rule_for` looks a host up by.
   */
  variants: (host: Hostname): Hostname[] => {
    const labels = host.split(".");
    return labels.map((_, index) => schema.parse(labels.slice(index).join(".")));
  },
  /**
   * The host of an ActivityPub URI, when it parses. Not an actor's account
   * domain, which can differ: an account's domain blocks match
   * `ofAuthority(actor.domain)`, as Mastodon matches `account.domain`.
   */
  ofUri: (uri: string): Hostname | undefined => {
    try {
      return schema.parse(withoutTrailingDots(new URL(uri).hostname.toLowerCase()));
    } catch {
      return undefined;
    }
  },
} as const;
