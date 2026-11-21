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
 * Why a round trip writes nothing: a refusal, or a lookup that could not
 * finish (`check_webfinger!` raises on it too). The latter is transient:
 * nothing is written, and the next request asks again.
 */
export type HandleWriteError = WebfingerRefusal | Readonly<{ kind: "WebfingerUnavailable" }>;

/** A handle WebFinger confirmed, stored with `last_webfingered_at` set to `webfingeredAt`. */
export type HandleWrite = Readonly<{ handle: AccountHandle; webfingeredAt: IsoInstant }>;

/**
 * The handle write a round trip calls for. Every actor fetch but an actor's
 * own `Update` (which keeps the stored handle without asking) runs Mastodon's
 * `check_webfinger!`, which raises on anything but a confirmation: the actor
 * is not stored, or a cached one is left as it was, document and keys
 * included.
 */
const handleWrite = (
  confirmation: WebfingerConfirmation,
  now: IsoInstant,
): Result<HandleWrite, HandleWriteError> => {
  switch (confirmation.kind) {
    case "Confirmed":
      return ok({ handle: confirmation.handle, webfingeredAt: now });
    case "Mismatch":
      return err({ kind: "WebfingerMismatch" });
    case "Unavailable":
      return err({ kind: "WebfingerUnavailable" });
    case "Refused":
      return err({ kind: "DomainRefused", host: confirmation.host });
    case "UnsupportedUsername":
      return err({ kind: "UnsupportedUsername" });
  }
};

export const WebfingerConfirmation = { handleWrite } as const;
