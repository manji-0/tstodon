import type { ApActorDocumentJSON } from "@tstodon/api/activitypub";
import type { InstanceIdentity, RemoteActor } from "@tstodon/domain";
import type { Context } from "hono";
import { optionalEnvString } from "./runtime-config";
import { signedFetchVerdict } from "./signed-fetch";

/**
 * Secure mode (OPS-11), Mastodon's `AUTHORIZED_FETCH`: with
 * `AUTHORIZED_FETCH` set to a true value, a GET of this server's own
 * ActivityPub objects (actors, notes, quote stamps, outboxes, follower and
 * following collections) needs a valid HTTP signature from an actor whose
 * domain federates here. Off by default. The instance actor (`/actor`),
 * WebFinger, NodeInfo and the web UI's pages stay public; an unsigned GET of
 * an actor gets the restricted document Mastodon serves then, so a remote
 * can still read the key it needs to verify that actor's signatures.
 */
export const authorizedFetchEnabled = (env: Env): boolean =>
  ["1", "true", "yes", "on"].includes(
    optionalEnvString(env, "AUTHORIZED_FETCH").trim().toLowerCase(),
  );

export type FetchAccess =
  /** Secure mode is off: everything as before. */
  | Readonly<{ kind: "Public" }>
  /** Secure mode, and an allowed remote actor signed the GET. */
  | Readonly<{ kind: "Signed"; actor: RemoteActor }>
  /** Secure mode, an actor document, and no usable signature: the restricted document. */
  | Readonly<{ kind: "Restricted" }>
  /** Secure mode refused the GET: send `response`. */
  | Readonly<{ kind: "Denied"; response: Response }>;

/**
 * Responses that depend on the signature must not be shared: `private`, so
 * no shared cache (a Cloudflare cache rule included) keeps a signed answer
 * for unsigned requests, and `Vary: Signature` for caches that key on it.
 */
const markPrivate = (c: Context<{ Bindings: Env }>): void => {
  c.header("Cache-Control", "private");
  c.header("Vary", "Signature");
};

/**
 * Whether a GET of a local ActivityPub object may be answered. An actor GET
 * (`object: "actor"`) without a usable signature is `Restricted` rather than
 * refused. Every outcome but `Public` marks the response private.
 */
export const authorizeObjectFetch = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  object: "actor" | "object" = "object",
): Promise<FetchAccess> => {
  if (!authorizedFetchEnabled(c.env)) {
    return { kind: "Public" };
  }
  markPrivate(c);
  const verdict = await signedFetchVerdict(c.env, identity, c.req.raw);
  switch (verdict.kind) {
    case "Signed":
      return { kind: "Signed", actor: verdict.actor };
    case "Refused":
      return {
        kind: "Denied",
        response: c.json(
          { error: "This instance does not federate with that domain", kind: "Forbidden" },
          403,
        ),
      };
    case "Unavailable":
      if (object === "actor") {
        return { kind: "Restricted" };
      }
      c.header("Retry-After", "5");
      return { kind: "Denied", response: c.json({ kind: "VerificationUnavailable" }, 503) };
    case "Unsigned":
    case "Invalid":
      if (object === "actor") {
        return { kind: "Restricted" };
      }
      return {
        kind: "Denied",
        response: c.json(
          {
            error:
              verdict.kind === "Unsigned"
                ? "Request not signed"
                : "Verification failed for the request's signature",
            kind: "InvalidSignature",
          },
          401,
        ),
      };
  }
};

/** What an unsigned GET of an actor sees in secure mode (Mastodon's `restrict_fields_to`). */
export type RestrictedActorDocumentJSON = Pick<
  ApActorDocumentJSON,
  "@context" | "id" | "type" | "preferredUsername" | "inbox" | "outbox" | "publicKey" | "endpoints"
>;

/**
 * The actor document cut to what verifying its signatures and delivering to
 * it need: `id`, `type`, `preferredUsername`, `inbox`, `outbox`, `publicKey`
 * and `endpoints`, as Mastodon's `AccountsController` serves an unsigned
 * request in secure mode. No profile, no collections, no `alsoKnownAs`.
 */
export const restrictedActorDocument = (
  document: ApActorDocumentJSON,
): RestrictedActorDocumentJSON => ({
  "@context": document["@context"],
  id: document.id,
  type: document.type,
  preferredUsername: document.preferredUsername,
  inbox: document.inbox,
  outbox: document.outbox,
  publicKey: document.publicKey,
  endpoints: document.endpoints,
});
