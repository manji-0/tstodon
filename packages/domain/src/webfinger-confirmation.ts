import { err, ok, type Result } from "neverthrow";
import type { Hostname } from "./hostname";

/** A `user@domain` handle; `domain` is an authority, `host[:port]`. */
export type AccountHandle = Readonly<{ username: string; domain: string }>;

/**
 * How the WebFinger round trip (Mastodon's `check_webfinger!`) ended for an
 * actor read from its own document.
 */
export type WebfingerConfirmation =
  /** WebFinger names `handle` and links back to the actor. */
  | Readonly<{ kind: "Confirmed"; handle: AccountHandle }>
  /** WebFinger answered for another actor, or with a subject that does not loop back. */
  | Readonly<{ kind: "Mismatch" }>
  /** A lookup failed (an error status, a timeout, an unreadable answer): nothing is known. */
  | Readonly<{ kind: "Unavailable" }>
  /** The account domain WebFinger claims is one this instance does not federate with. */
  | Readonly<{ kind: "Refused"; host: Hostname }>;

export type WebfingerRefusal = Readonly<{ kind: "DomainRefused"; host: Hostname }>;

/**
 * The handle to cache an actor under. `fromDocument` is its
 * `preferredUsername` at the URI's authority, which the document proves;
 * `stored` is the handle already cached for the actor URI. A lookup that
 * could not finish leaves the stored handle alone, so a WebFinger outage
 * never moves an actor off its account domain and the rules on it. Only a
 * definite answer for another actor falls back to the URI's authority.
 */
const handleToCache = (
  confirmation: WebfingerConfirmation,
  fromDocument: AccountHandle,
  stored: AccountHandle | undefined,
): Result<AccountHandle, WebfingerRefusal> => {
  switch (confirmation.kind) {
    case "Confirmed":
      return ok(confirmation.handle);
    case "Mismatch":
      return ok(fromDocument);
    case "Unavailable":
      return ok(stored ?? fromDocument);
    case "Refused":
      return err({ kind: "DomainRefused", host: confirmation.host });
  }
};

export const WebfingerConfirmation = { handleToCache } as const;
