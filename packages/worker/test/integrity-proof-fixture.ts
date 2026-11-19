import { canonicalJson } from "../server/json-canonical";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Bitcoin-alphabet base58 with its `z` multibase prefix. */
export const base58btc = (bytes: Uint8Array): string => {
  let value = bytes.reduce((sum, byte) => sum * 256n + BigInt(byte), 0n);
  let text = "";
  while (value > 0n) {
    text = BASE58_ALPHABET.charAt(Number(value % 58n)) + text;
    value /= 58n;
  }
  const zeros = bytes.findIndex((byte) => byte !== 0);
  return `z${"1".repeat(zeros < 0 ? bytes.length : zeros)}${text}`;
};

export type Ed25519Signer = Readonly<{
  /** The public key as a FEP-521a `publicKeyMultibase` (`ed25519-pub`). */
  publicKeyMultibase: string;
  /**
   * `document` with an `eddsa-jcs-2022` proof (FEP-8b32) made with this key
   * under `keyId`, as the Data Integrity spec makes one; `extra` adds to the
   * proof's options before signing.
   */
  prove: (
    document: Readonly<Record<string, unknown>>,
    keyId: string,
    extra?: Readonly<Record<string, unknown>>,
  ) => Promise<Record<string, unknown>>;
}>;

const sha256 = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** A new Ed25519 key that makes FEP-8b32 proofs. */
export const ed25519Signer = async (): Promise<Ed25519Signer> => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) {
    throw new Error("Ed25519 key generation gave no pair");
  }
  const exported = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(exported instanceof ArrayBuffer)) {
    throw new Error("Ed25519 public key did not export raw");
  }
  const raw = new Uint8Array(exported);
  return {
    publicKeyMultibase: base58btc(Uint8Array.from([0xed, 0x01, ...raw])),
    prove: async (document, keyId, extra = {}) => {
      const options = {
        type: "DataIntegrityProof",
        cryptosuite: "eddsa-jcs-2022",
        verificationMethod: keyId,
        proofPurpose: "assertionMethod",
        created: new Date().toISOString(),
        ...extra,
      };
      const { proof: _previous, ...unsecured } = document;
      const hashData = Uint8Array.from([
        ...(await sha256(canonicalJson(options))),
        ...(await sha256(canonicalJson(unsecured))),
      ]);
      const signature = new Uint8Array(
        await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, hashData),
      );
      return { ...unsecured, proof: { ...options, proofValue: base58btc(signature) } };
    },
  };
};
