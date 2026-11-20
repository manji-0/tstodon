import { err, ok, type Result } from "neverthrow";
import type { OutboundFollowState } from "./outbound-follow";
import type { Visibility } from "./visibility";

/**
 * Followers collection synchronization (FEP-8fcf), as Mastodon v4.7.5 does
 * it. A followers-only status goes out with a `Collection-Synchronization`
 * header that tells the receiving server which of its accounts the sender
 * counts as followers (a digest of their URIs) and where to read that list;
 * the receiver drops the follows the sender no longer lists.
 */

/**
 * An account with this many followers or more sends no header
 * (`ActivityPub::DistributionWorker::MAX_FOLLOWERS_FOR_SYNCHRONIZATION`).
 */
export const MAX_FOLLOWERS_FOR_SYNCHRONIZATION = 25_000;

/** Pages of the partial collection read (`SynchronizeFollowersService::MAX_COLLECTION_PAGES`). */
export const SYNCHRONIZATION_MAX_PAGES = 10;

/** `Account::URL_PREFIX_RE`: the scheme and authority, as written. */
const URL_PREFIX = /^https?:\/\/[^/]+/;

/** Ruby's `\s`. */
const SPACE = "[ \\t\\r\\n\\f\\v]";
/** `SignatureParser::PARAM_RE`: a token key, then a token or a quoted string. */
const PARAM = new RegExp(
  `([0-9a-zA-Z!#$%&'*+.^_\`|~-]+)${SPACE}*=${SPACE}*(?:([0-9a-zA-Z!#$%&'*+.^_\`|~-]+)|("(?:[^\\\\"]|\\\\.)*"))`,
  "y",
);
const SPACES = new RegExp(`${SPACE}*`, "y");
const SEPARATOR = new RegExp(`${SPACE}*,${SPACE}*`, "y");

export type CollectionSynchronizationHeader = Readonly<{
  collectionId: string;
  digest: string;
  url: string;
}>;

/**
 * A header that does not parse. Mastodon logs and ignores `MalformedHeader`
 * (`SignatureParser::ParsingError`); `DuplicateKey` raises an error it does
 * not rescue.
 */
export type CollectionSynchronizationParseError = Readonly<{
  kind: "MalformedHeader" | "DuplicateKey";
}>;

/** What a follow a remote's partial collection lists becomes (`handle_unexpected_outgoing_follows!`). */
export type ListedFollowAction =
  /** It is a follow here too. */
  | Readonly<{ kind: "Keep" }>
  /** A request here: the `Accept` was missed, so it is accepted. */
  | Readonly<{ kind: "Authorize" }>
  /** No follow here: the remote is told to drop it with an `Undo`. */
  | Readonly<{ kind: "Undo" }>;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const digestOf = async (uris: Iterable<string>): Promise<string> => {
  const encoder = new TextEncoder();
  const hashes = await Promise.all(
    Array.from(uris, (uri) => crypto.subtle.digest("SHA-256", encoder.encode(uri))),
  );
  const digest = new Uint8Array(32);
  for (const hash of hashes) {
    const bytes = new Uint8Array(hash);
    for (let i = 0; i < digest.length; i += 1) {
      digest[i] = (digest[i] ?? 0) ^ (bytes[i] ?? 0);
    }
  }
  return hex(digest);
};

export const FollowersSynchronization = {
  /** The XOR of the SHA-256 of each URI, as lowercase hex (`remote_followers_hash`). */
  digest: digestOf,
  /** The scheme and authority of `url` as written, or undefined when it is not an http(s) URL. */
  uriPrefix: (url: string): string | undefined => URL_PREFIX.exec(url)?.[0],
  /** `Account.matches_uri_prefix`: `uri` is `prefix` or under `prefix/`, case-sensitively. */
  underPrefix: (uri: string, prefix: string): boolean =>
    uri === prefix || uri.startsWith(`${prefix}/`),
  /** The header, as `ActivityPub::DeliveryWorker#synchronization_header` writes it. */
  header: (value: CollectionSynchronizationHeader): string =>
    `collectionId="${value.collectionId}", digest="${value.digest}", url="${value.url}"`,
  /**
   * The header's parameters, read as Mastodon's `SignatureParser` reads them:
   * a quoted value keeps its quoted pairs as written.
   */
  parseHeader: (
    raw: string,
  ): Result<ReadonlyMap<string, string>, CollectionSynchronizationParseError> => {
    const input = raw.startsWith("Signature ") ? raw.slice("Signature ".length) : raw;
    const params = new Map<string, string>();
    let at = 0;
    for (;;) {
      PARAM.lastIndex = at;
      const param = PARAM.exec(input);
      if (param === null) {
        return err({ kind: "MalformedHeader" });
      }
      const [matched, key = "", token, quoted] = param;
      if (params.has(key)) {
        return err({ kind: "DuplicateKey" });
      }
      params.set(key, token ?? quoted?.slice(1, -1) ?? "");
      SPACES.lastIndex = at + matched.length;
      SPACES.exec(input);
      at = SPACES.lastIndex;
      if (at === input.length) {
        return ok(params);
      }
      SEPARATOR.lastIndex = at;
      const separator = SEPARATOR.exec(input);
      if (separator === null) {
        return err({ kind: "MalformedHeader" });
      }
      at += separator[0].length;
    }
  },
  /**
   * Whether a status's `Create`, `Update` or `Announce` carries the header
   * (`DistributionWorker#options`): followers-only, from an account under
   * {@link MAX_FOLLOWERS_FOR_SYNCHRONIZATION} followers.
   */
  synchronizes: (visibility: Visibility, followersCount: number): boolean =>
    visibility.kind === "FollowersOnly" && followersCount < MAX_FOLLOWERS_FOR_SYNCHRONIZATION,
  /**
   * Whether the URIs a partial collection listed add up to `expected`, as
   * `SynchronizeFollowersService` XORs each into the digest it was given
   * (`pack('H*')`, so either case) and checks for zero.
   */
  matchesDigest: async (listed: Iterable<string>, expected: string): Promise<boolean> =>
    (await digestOf(listed)) === expected.toLowerCase(),
  listedFollowAction: (state: OutboundFollowState | undefined): ListedFollowAction => {
    if (state === undefined) {
      return { kind: "Undo" };
    }
    return state.kind === "Accepted" ? { kind: "Keep" } : { kind: "Authorize" };
  },
} as const;
