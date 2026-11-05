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
  /** A lookup failed (a 5xx, a timeout, an unreadable answer): nothing is known. */
  | Readonly<{ kind: "Unavailable" }>
  /** The round trip was not run: an actor's own `Update`, as Mastodon applies it. */
  | Readonly<{ kind: "Unchecked" }>
  /** The account domain WebFinger claims is one this instance does not federate with. */
  | Readonly<{ kind: "Refused"; host: Hostname }>;

export type WebfingerRefusal = Readonly<{ kind: "DomainRefused"; host: Hostname }>;

/** A handle and when WebFinger last confirmed it; `webfingeredAt` is absent when it never did. */
export type CachedHandle = AccountHandle & Readonly<{ webfingeredAt?: IsoInstant }>;

/**
 * The handle to cache an actor under. `fromDocument` is its
 * `preferredUsername` at the URI's authority, which the document proves;
 * `stored` is the handle already cached for the actor URI. A confirmed
 * handle is stamped `now`. A lookup that could not finish, or was not run,
 * keeps the stored handle and its stamp, so a WebFinger outage does not move
 * an actor off its account domain and does not make that handle look newly
 * confirmed. This guards against outages only: the URI host can always
 * answer for its own authority and so move the actor there. A definite
 * answer that the domain does not vouch for the actor falls back to the
 * URI's authority.
 */
const handleToCache = (
  confirmation: WebfingerConfirmation,
  fromDocument: AccountHandle,
  stored: CachedHandle | undefined,
  now: IsoInstant,
): Result<CachedHandle, WebfingerRefusal> => {
  switch (confirmation.kind) {
    case "Confirmed":
      return ok({ ...confirmation.handle, webfingeredAt: now });
    case "Mismatch":
      return ok(fromDocument);
    case "Unavailable":
    case "Unchecked":
      return ok(stored ?? fromDocument);
    case "Refused":
      return err({ kind: "DomainRefused", host: confirmation.host });
  }
};

export const WebfingerConfirmation = { handleToCache } as const;
