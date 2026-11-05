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
   * dropped. `undefined` when nothing is left.
   */
  fromInput: (raw: string): Hostname | undefined => {
    const host = ofAuthority(
      raw
        .trim()
        .replace(/^@/, "")
        .replace(/^https?:\/\//i, "")
        .replace(/\/.*$/, ""),
    );
    return host.length > 0 ? host : undefined;
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
