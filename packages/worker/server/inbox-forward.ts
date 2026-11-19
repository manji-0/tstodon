import { Hostname, type RemoteActor, type InstanceIdentity } from "@tstodon/domain";
import type { RepositoryError } from "./d1";
import type { FederatedFetchOptions } from "./federated-fetch";
import {
  type LdSignatureRefusal,
  ldSignedBytes,
  readLdSignature,
  verifyLdSignature,
} from "./ld-signature";
import { resolveKeyOwner } from "./remote-actor-fetch";
import { allowListAdmits } from "./runtime-config";

/** Why the actor's own signature on a forwarded activity does not vouch for it. */
export type UnverifiedForwardReason =
  | LdSignatureRefusal["kind"]
  /** The signing key is on a host that does not federate here. */
  | "DomainRefused"
  /** The key is not the actor's, or could not be read as an actor's key. */
  | "KeyRejected"
  /** The actor's key does not verify the signature. */
  | "SignatureMismatch";

/** What the inbox makes of an activity whose request another actor signed. */
export type ForwardVerdict =
  /** The activity's actor signed it (`RsaSignature2017`): it is that actor's. */
  | Readonly<{ kind: "Verified"; author: RemoteActor }>
  /** Nothing vouches for it, so it is dropped, as Mastodon drops it. */
  | Readonly<{ kind: "Unverified"; reason: UnverifiedForwardReason }>
  /** The actor's key could not be read now: the forwarder may retry. */
  | Readonly<{ kind: "Unavailable" }>
  | RepositoryError;

/**
 * Whether `actorUri`, the actor `body` names, signed `body` itself, as
 * Mastodon's `ProcessActivityService` checks an activity relayed by another
 * account (`different_actor?`): the Linked Data signature's key must be on a
 * host that federates here, belong to that actor (its owner read as a
 * delivery's key is: cached, or fetched, and refetched once if it rotated)
 * and verify the signature over the body as received. Mastodon also accepts a FEP-8b32 integrity proof
 * there; tstodon does not read Ed25519 keys (FED-8), so it does not.
 */
export const verifyForwardedActivity = async (
  db: D1Database,
  identity: InstanceIdentity,
  body: unknown,
  actorUri: string,
  options: FederatedFetchOptions &
    Readonly<{ allowHosts: ReadonlySet<string>; blockedHosts: ReadonlySet<Hostname> }>,
  now: Date = new Date(),
): Promise<ForwardVerdict> => {
  const signed = readLdSignature(body, now);
  if (signed.isErr()) {
    return { kind: "Unverified", reason: signed.error.kind };
  }
  const keyHost = Hostname.ofUri(signed.value.keyId);
  if (
    keyHost === undefined ||
    options.blockedHosts.has(keyHost) ||
    !allowListAdmits(options.allowHosts, keyHost)
  ) {
    return { kind: "Unverified", reason: "DomainRefused" };
  }
  const bytes = await ldSignedBytes(signed.value);
  if (bytes.isErr()) {
    return { kind: "Unverified", reason: bytes.error.kind };
  }
  const verify = (publicKeyPem: string): Promise<boolean> =>
    verifyLdSignature(signed.value, bytes.value, publicKeyPem);
  const author = await resolveKeyOwner(db, identity, signed.value.keyId, {
    ...options,
    checkSignature: verify,
  });
  if (author.isErr()) {
    switch (author.error.kind) {
      case "VerificationUnavailable":
        return { kind: "Unavailable" };
      case "RepositoryError":
        return author.error;
      case "DomainRefused":
        return { kind: "Unverified", reason: "DomainRefused" };
      case "InvalidSignature":
        return { kind: "Unverified", reason: "KeyRejected" };
    }
  }
  // As Mastodon's `different_actor?` after `verify_actor!`: the key must be
  // the activity's actor's own.
  if (author.value.actorUri !== actorUri) {
    return { kind: "Unverified", reason: "KeyRejected" };
  }
  // A cached key that does not verify comes back unchanged when its refetch
  // is not due, so the signature is checked against the key returned.
  return (await verify(author.value.publicKeyPem))
    ? { kind: "Verified", author: author.value }
    : { kind: "Unverified", reason: "SignatureMismatch" };
};
