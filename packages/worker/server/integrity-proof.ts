import { err, ok, type Result } from "neverthrow";
import { canonicalJson } from "./json-canonical";
import { decodeMultibase } from "./multibase";

/**
 * FEP-8b32 object integrity proofs, as Mastodon's
 * `ActivityPub::ObjectIntegrityProof` checks one on a forwarded activity
 * whose Linked Data signature is missing or does not verify: a
 * `DataIntegrityProof` for `assertionMethod`, made with the actor's Ed25519
 * key over the JCS form of the proof's options and of the document
 * (`eddsa-jcs-2022`).
 *
 * Mastodon also accepts `mldsa44-jcs-2024`. No Workers API verifies ML-DSA,
 * so such a proof is refused here.
 */

export type IntegrityProofRefusal =
  /** No `proof` object. */
  | Readonly<{ kind: "Unproved" }>
  /**
   * Not a `DataIntegrityProof` for `assertionMethod` with a key and a value,
   * a cryptosuite other than `eddsa-jcs-2022`, a value that is not
   * multibase, or a proof `@context` that is not the start of the
   * document's.
   */
  | Readonly<{ kind: "UnsupportedProof" }>
  /** Its `expires` is past or does not parse. */
  | Readonly<{ kind: "ProofExpired" }>;

/** An integrity proof an activity carries, read but not yet checked. */
export type IntegrityProof = Readonly<{
  /** The key that made it (`verificationMethod`). */
  keyId: string;
  /** What the signature is over: SHA-256 of the proof's options, then of the document. */
  hashData: Uint8Array;
  signature: Uint8Array;
  /**
   * The document the proof covers, which is what may be processed: the
   * activity without `proof`, and with only the proof's `@context` when the
   * proof names one.
   */
  document: Readonly<Record<string, unknown>>;
}>;

const EDDSA_JCS_2022 = "eddsa-jcs-2022";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Ruby's `present?`: not nil, false, or an empty string, list or object. */
const present = (value: unknown): boolean => {
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return !isRecord(value) || Object.keys(value).length > 0;
};

const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

const sha256 = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/**
 * The `eddsa-jcs-2022` proof of `body` (an activity without its Linked Data
 * `signature`, as Mastodon checks it), as `verify_actor!` reads it before it
 * looks up the key, and `verify_eddsa_jcs_2022` hashes it: a proof whose
 * options name an `@context` must name the first entries of the document's
 * (a list), and the document is then hashed with only those.
 */
export const readIntegrityProof = async (
  body: Readonly<Record<string, unknown>>,
  now: Date,
): Promise<Result<IntegrityProof, IntegrityProofRefusal>> => {
  const { proof, ...unsecured } = body;
  if (!isRecord(proof)) {
    return err({ kind: "Unproved" });
  }
  const keyId = proof["verificationMethod"];
  const value = proof["proofValue"];
  if (
    proof["type"] !== "DataIntegrityProof" ||
    proof["proofPurpose"] !== "assertionMethod" ||
    typeof keyId !== "string" ||
    !present(keyId)
  ) {
    return err({ kind: "UnsupportedProof" });
  }
  const expires = proof["expires"];
  if (expires !== undefined && expires !== null) {
    const at = typeof expires === "string" ? Date.parse(expires) : Number.NaN;
    if (Number.isNaN(at) || at < now.getTime()) {
      return err({ kind: "ProofExpired" });
    }
  }
  if (proof["cryptosuite"] !== EDDSA_JCS_2022 || typeof value !== "string" || !present(value)) {
    return err({ kind: "UnsupportedProof" });
  }
  const signature = decodeMultibase(value);
  if (signature === undefined) {
    return err({ kind: "UnsupportedProof" });
  }
  const { proofValue: _value, ...options } = proof;
  const proofContext = options["@context"];
  let document: Readonly<Record<string, unknown>> = unsecured;
  if (present(proofContext)) {
    const context = unsecured["@context"];
    if (
      !Array.isArray(proofContext) ||
      !Array.isArray(context) ||
      !sameJson(context.slice(0, proofContext.length), proofContext)
    ) {
      return err({ kind: "UnsupportedProof" });
    }
    document = { ...unsecured, "@context": proofContext };
  }
  const [optionsHash, documentHash] = await Promise.all([
    sha256(canonicalJson(options)),
    sha256(canonicalJson(document)),
  ]);
  return ok({
    keyId,
    hashData: Uint8Array.from([...optionsHash, ...documentHash]),
    signature,
    document,
  });
};

/** Whether `publicKeyPem` (an Ed25519 key, SPKI) made `proof`'s signature. */
export const verifyIntegrityProof = async (
  proof: IntegrityProof,
  publicKeyPem: string,
): Promise<boolean> => {
  try {
    const spki = Uint8Array.from(
      atob(publicKeyPem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s/g, "")),
      (char) => char.charCodeAt(0),
    );
    const key = await crypto.subtle.importKey("spki", spki, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, proof.signature, proof.hashData);
  } catch {
    return false;
  }
};
