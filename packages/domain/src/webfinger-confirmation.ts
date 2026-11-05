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
  | Readonly<{ kind: "Refused"; host: Hostname }>;

export type WebfingerRefusal = Readonly<{ kind: "DomainRefused"; host: Hostname }>;

/**
 * How actor fetch writes an actor's handle (`username@domain` and
 * `last_webfingered_at`) after the round trip.
 */
export type HandleWrite =
  /** Store `handle`, confirmed `webfingeredAt`, and take it from every other row. */
  | Readonly<{ kind: "Confirm"; handle: AccountHandle; webfingeredAt: IsoInstant }>
  /** Store the URI's authority, which the document proves, unconfirmed. */
  | Readonly<{ kind: "UriAuthority" }>
  /**
   * Leave the handle and its stamp as the row holds them when it is written,
   * not as it was read before the round trip, so a confirmation another actor
   * made meanwhile stands. A row not cached yet takes the URI's authority.
   */
  | Readonly<{ kind: "Keep" }>;

/**
 * The handle write a round trip calls for. A lookup that could not finish
 * keeps the cached handle and its stamp, so an outage does not move an actor
 * off its account domain and does not make that handle look newly confirmed.
 * The round trip ends `Unavailable` only while the URI host still names the
 * cached handle, or when that handle is the URI's own. A definite answer that
 * the domain does not vouch for the actor falls back to the URI's authority.
 */
const handleWrite = (
  confirmation: WebfingerConfirmation,
  now: IsoInstant,
): Result<HandleWrite, WebfingerRefusal> => {
  switch (confirmation.kind) {
    case "Confirmed":
      return ok({ kind: "Confirm", handle: confirmation.handle, webfingeredAt: now });
    case "Mismatch":
      return ok({ kind: "UriAuthority" });
    case "Unavailable":
      return ok({ kind: "Keep" });
    case "Refused":
      return err({ kind: "DomainRefused", host: confirmation.host });
  }
};

export const WebfingerConfirmation = { handleWrite } as const;
