import {
  Hostname,
  type RemoteActor,
  type RemoteActorKey,
  type InstanceIdentity,
} from "@tstodon/domain";
import type { RepositoryError } from "./d1";
import type { FederatedFetchOptions } from "./federated-fetch";
import {
  type IntegrityProofRefusal,
  readIntegrityProof,
  verifyIntegrityProof,
} from "./integrity-proof";
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
  | IntegrityProofRefusal["kind"]
  /** The signing key is on a host that does not federate here. */
  | "DomainRefused"
  /** The key is not the actor's, or could not be read as an actor's key. */
  | "KeyRejected"
  /** The actor's key does not verify the signature. */
  | "SignatureMismatch";

/** What the inbox makes of an activity whose request another actor signed. */
export type ForwardVerdict =
  /**
   * The activity's actor vouches for it: it is that actor's, and `document`
   * is what is processed. For a Linked Data signature that is the body as
   * received; for a FEP-8b32 proof, the document the proof covers, without
   * the signature that did not verify, so it is not forwarded on.
   */
  | Readonly<{ kind: "Verified"; author: RemoteActor; document: unknown }>
  /** Nothing vouches for it, so it is dropped, as Mastodon drops it. */
  | Readonly<{ kind: "Unverified"; reason: UnverifiedForwardReason }>
  /** The actor's key could not be read now: the forwarder may retry. */
  | Readonly<{ kind: "Unavailable" }>
  | RepositoryError;

type ForwardOptions = FederatedFetchOptions &
  Readonly<{ allowHosts: ReadonlySet<string>; blockedHosts: ReadonlySet<Hostname> }>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Mastodon's `domain_not_allowed?` for a key, checked before anything is fetched or hashed. */
const keyHostRefused = (keyId: string, options: ForwardOptions): boolean => {
  const keyHost = Hostname.ofUri(keyId);
  return (
    keyHost === undefined ||
    options.blockedHosts.has(keyHost) ||
    !allowListAdmits(options.allowHosts, keyHost)
  );
};

/**
 * The actor that owns `keyId`, when it is `actorUri` and `verify` accepts its
 * key, as `verify_actor!` and then `different_actor?` read it: the key must
 * belong to that actor (its owner read as a delivery's key is: cached, or
 * fetched, and refetched once if it rotated).
 */
const keyOwnerVouching = async (
  db: D1Database,
  identity: InstanceIdentity,
  keyId: string,
  actorUri: string,
  options: ForwardOptions,
  verify: (key: RemoteActorKey) => Promise<boolean>,
): Promise<ForwardVerdict | RemoteActor> => {
  const author = await resolveKeyOwner(db, identity, keyId, { ...options, checkSignature: verify });
  if (author.isErr()) {
    switch (author.error.kind) {
      case "VerificationUnavailable":
        return { kind: "Unavailable" };
      case "RepositoryError":
        return author.error;
      case "DomainRefused":
        return { kind: "Unverified", reason: "DomainRefused" };
      case "InvalidSignature":
      case "UnsupportedUsername":
      case "WebfingerMismatch":
        return { kind: "Unverified", reason: "KeyRejected" };
    }
  }
  if (author.value.actor.actorUri !== actorUri) {
    return { kind: "Unverified", reason: "KeyRejected" };
  }
  // A cached key that does not verify comes back unchanged when its refetch
  // is not due, so the signature is checked against the key returned.
  return (await verify(author.value.key))
    ? author.value.actor
    : { kind: "Unverified", reason: "SignatureMismatch" };
};

/**
 * Whether `actorUri`, the actor `body` names, vouches for `body` itself, as
 * Mastodon's `ProcessActivityService` checks an activity relayed by another
 * account (`different_actor?`). First its Linked Data signature
 * (`RsaSignature2017`), over the body as received, with that actor's RSA key.
 * When that is missing or does not verify, its FEP-8b32 integrity proof
 * (`eddsa-jcs-2022`), over the body without the signature, with that actor's
 * Ed25519 key. The refusal reported is the proof's when the body has one.
 */
export const verifyForwardedActivity = async (
  db: D1Database,
  identity: InstanceIdentity,
  body: unknown,
  actorUri: string,
  options: ForwardOptions,
  now: Date = new Date(),
): Promise<ForwardVerdict> => {
  const signature = await verifyLdSigned(db, identity, body, actorUri, options, now);
  if (signature.kind !== "Unverified" || !isRecord(body) || !isRecord(body["proof"])) {
    return signature;
  }
  const { signature: _signature, ...unsigned } = body;
  const proof = await readIntegrityProof(unsigned, now);
  if (proof.isErr()) {
    return { kind: "Unverified", reason: proof.error.kind };
  }
  if (keyHostRefused(proof.value.keyId, options)) {
    return { kind: "Unverified", reason: "DomainRefused" };
  }
  // As Mastodon's `verify_actor!`: only an Ed25519 key checks `eddsa-jcs-2022`.
  const verify = async (key: RemoteActorKey): Promise<boolean> =>
    key.kind === "Ed25519" && verifyIntegrityProof(proof.value, key.publicKeyPem);
  const author = await keyOwnerVouching(db, identity, proof.value.keyId, actorUri, options, verify);
  return author.kind === "RemoteActor"
    ? { kind: "Verified", author, document: proof.value.document }
    : author;
};

/** The Linked Data signature half of {@link verifyForwardedActivity}. */
const verifyLdSigned = async (
  db: D1Database,
  identity: InstanceIdentity,
  body: unknown,
  actorUri: string,
  options: ForwardOptions,
  now: Date,
): Promise<ForwardVerdict> => {
  const signed = readLdSignature(body, now);
  if (signed.isErr()) {
    return { kind: "Unverified", reason: signed.error.kind };
  }
  if (keyHostRefused(signed.value.keyId, options)) {
    return { kind: "Unverified", reason: "DomainRefused" };
  }
  const bytes = await ldSignedBytes(signed.value);
  if (bytes.isErr()) {
    return { kind: "Unverified", reason: bytes.error.kind };
  }
  // As Mastodon's `verify_actor!`: only an RSA key checks an `RsaSignature2017`.
  const verify = async (key: RemoteActorKey): Promise<boolean> =>
    key.kind === "Rsa" && verifyLdSignature(signed.value, bytes.value, key.publicKeyPem);
  const author = await keyOwnerVouching(
    db,
    identity,
    signed.value.keyId,
    actorUri,
    options,
    verify,
  );
  return author.kind === "RemoteActor" ? { kind: "Verified", author, document: body } : author;
};
