import { err, ok, type Result } from "neverthrow";
import type { Hostname } from "./hostname";
import type { IsoInstant } from "./iso-instant";

/** A `user@domain` handle; `domain` is an authority, `host[:port]`. */
export type AccountHandle = Readonly<{ username: string; domain: string }>;

/**
 * How the WebFinger round trip (Mastodon's `check_webfinger!`) ended for an
 * actor read from its own document.
 */
export type WebfingerConfirmation =
  /** WebFinger names `handle` and links back to the actor. */
  | Readonly<{ kind: "Confirmed"; handle: AccountHandle }>
  /**
   * WebFinger answered for another actor, with a subject that does not loop
   * back, or with 404 or 410: the domain does not vouch for the actor.
   */
  | Readonly<{ kind: "Mismatch" }>
  /**
   * The URI host names the cached handle, and that handle's domain did not
   * answer usably (anything but 404 or 410: a 5xx, a timeout, a 3xx, a 401,
   * 403 or other 4xx, an unreadable answer, no `self` link); or a lookup
   * failed so for an actor not cached on another domain. Nothing is known.
   */
  | Readonly<{ kind: "Unavailable" }>
  /** The account domain WebFinger claims is one this instance does not federate with. */
  | Readonly<{ kind: "Refused"; host: Hostname }>
  /**
   * WebFinger names a username Mastodon's `Account::USERNAME_ONLY_RE` does
   * not match: `check_webfinger!` raises, and the actor is not stored.
   */
  | Readonly<{ kind: "UnsupportedUsername" }>;

export type WebfingerRefusal =
  | Readonly<{ kind: "DomainRefused"; host: Hostname }>
  | Readonly<{ kind: "UnsupportedUsername" }>
  /**
   * WebFinger does not vouch for the handle an actor's document claims:
   * `check_webfinger!` raises, and Mastodon stores no account, or leaves a
   * cached one as it was.
   */
  | Readonly<{ kind: "WebfingerMismatch" }>;

/**
 * Why a round trip writes nothing: a refusal, or a lookup for an actor not
 * cached yet that could not finish (`check_webfinger!` raises on it too). The
 * latter is transient: nothing is stored, and the next request asks again.
 */
export type HandleWriteError = WebfingerRefusal | Readonly<{ kind: "WebfingerUnavailable" }>;

/**
 * How actor fetch writes an actor's handle (`username@domain` and
 * `last_webfingered_at`) after the round trip.
 */
export type HandleWrite =
  /** Store `handle`, confirmed `webfingeredAt`, and take it from every other row. */
  | Readonly<{ kind: "Confirm"; handle: AccountHandle; webfingeredAt: IsoInstant }>
  /**
   * Leave the handle and its stamp as the row holds them when it is written,
   * not as it was read before the round trip, so a confirmation another actor
   * made meanwhile stands.
   */
  | Readonly<{ kind: "Keep" }>;

/**
 * Whether the actor the round trip ran for is cached already, and if so
 * whether its document claims the handle it is cached under (its FEP-2c59
 * `webfinger`, else `preferredUsername` at its URI's authority), which
 * Mastodon's `extract_username_and_domain!` checks before it asks WebFinger.
 */
export type ActorRecord = "FirstSeen" | "CachedUnderClaimedHandle" | "CachedUnderOtherHandle";

/**
 * The handle write a round trip calls for. Mastodon asks WebFinger only for
 * a handle the account is not stored under, and `check_webfinger!` raises on
 * any failure, so an actor the domain does not vouch for is not stored, or is
 * left as it was, unless it is cached under the handle its document claims:
 * Mastodon updates that one without asking. A lookup that could not finish
 * keeps a cached actor's handle and its stamp, so an outage does not move it
 * off its account domain or make that handle look newly confirmed; it stores
 * no first-seen actor, which the next request looks up again.
 */
const handleWrite = (
  confirmation: WebfingerConfirmation,
  now: IsoInstant,
  record: ActorRecord,
): Result<HandleWrite, HandleWriteError> => {
  switch (confirmation.kind) {
    case "Confirmed":
      return ok({ kind: "Confirm", handle: confirmation.handle, webfingeredAt: now });
    case "Mismatch":
      return record === "CachedUnderClaimedHandle"
        ? ok({ kind: "Keep" })
        : err({ kind: "WebfingerMismatch" });
    case "Unavailable":
      return record === "FirstSeen" ? err({ kind: "WebfingerUnavailable" }) : ok({ kind: "Keep" });
    case "Refused":
      return err({ kind: "DomainRefused", host: confirmation.host });
    case "UnsupportedUsername":
      return err({ kind: "UnsupportedUsername" });
  }
};

export const WebfingerConfirmation = { handleWrite } as const;
