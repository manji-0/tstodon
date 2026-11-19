import { RemoteActor } from "@tstodon/domain";
import { describe, expect, it } from "vite-plus/test";
import { readIntegrityProof, verifyIntegrityProof } from "./integrity-proof";
import { canonicalJson } from "./json-canonical";
import {
  JCS_DOCUMENTS,
  MASTODON_JCS,
  MASTODON_MULTIKEYS,
  MASTODON_PROOFS,
  MASTODON_USERNAMES,
  PROOF_VERIFICATION_METHOD,
} from "./key-forms.fixture";
import { multibaseKey } from "./multibase";

// The fixture is what Mastodon v4.7.5 itself makes of each input
// (scripts/generate-key-forms-reference.mjs).

const NOW = new Date("2026-11-19T12:00:00Z");

const ed25519Pem = (): string => {
  const pem = MASTODON_MULTIKEYS["ed25519"]?.pem;
  if (pem === undefined) {
    throw new Error("fixture has no Ed25519 key");
  }
  return pem;
};

/** Whether the proof on `document` verifies with the fixture's key, as the forward check reads it. */
const verifies = async (document: Readonly<Record<string, unknown>>): Promise<boolean> => {
  const { signature: _signature, ...unsigned } = document;
  const proof = await readIntegrityProof(unsigned, NOW);
  return proof.isOk() && (await verifyIntegrityProof(proof.value, ed25519Pem()));
};

describe("remote usernames", () => {
  it.each(Object.entries(MASTODON_USERNAMES))(
    "matches Mastodon's Account::USERNAME_ONLY_RE on %j",
    (username, accepted) => {
      expect(RemoteActor.acceptsUsername(username)).toBe(accepted);
    },
  );
});

describe("multibase keys (FEP-521a)", () => {
  it.each(Object.entries(MASTODON_MULTIKEYS))(
    "reads %s as Mastodon's Multibase.decode_key_to_pem does",
    (_name, { multibase, type, pem }) => {
      const key = multibaseKey(multibase);
      if (type === undefined) {
        expect(key).toBeUndefined();
        return;
      }
      expect(key).toEqual({ kind: type === "ed25519" ? "Ed25519" : "Rsa", publicKeyPem: pem });
    },
  );

  it("imports the Ed25519 PEM it writes into WebCrypto", async () => {
    const der = Uint8Array.from(
      atob(
        ed25519Pem()
          .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
          .replace(/\s/g, ""),
      ),
      (char) => char.charCodeAt(0),
    );
    await expect(
      crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]),
    ).resolves.toBeDefined();
  });
});

describe("JCS", () => {
  it.each(Object.keys(MASTODON_JCS))("writes %s as Mastodon's to_json_c14n does", (name) => {
    expect(canonicalJson(JCS_DOCUMENTS[name])).toBe(MASTODON_JCS[name]);
  });
});

describe("eddsa-jcs-2022 proofs (FEP-8b32)", () => {
  it.each(Object.entries(MASTODON_PROOFS))(
    "agrees with Mastodon's verify_eddsa_jcs_2022 on %s",
    async (_name, { document, verified }) => {
      expect(await verifies(document)).toBe(verified);
    },
  );

  it("names the key that made the proof", async () => {
    const signed = MASTODON_PROOFS["signed"];
    if (signed === undefined) {
      throw new Error("fixture has no signed document");
    }
    const proof = await readIntegrityProof(signed.document, NOW);
    expect(proof.isOk() && proof.value.keyId).toBe(PROOF_VERIFICATION_METHOD);
  });

  it("covers the document with only the proof's context, which is what is processed", async () => {
    const extended = MASTODON_PROOFS["contextExtended"];
    if (extended === undefined) {
      throw new Error("fixture has no extended document");
    }
    const proof = await readIntegrityProof(extended.document, NOW);
    expect(proof.isOk()).toBe(true);
    if (proof.isOk()) {
      expect(proof.value.document["@context"]).toEqual([
        "https://www.w3.org/ns/activitystreams",
        "https://w3id.org/security/data-integrity/v1",
      ]);
      expect(proof.value.document).not.toHaveProperty("proof");
    }
  });

  it("refuses a proof that is expired, for another purpose, of another suite, or of another key", async () => {
    const signed = MASTODON_PROOFS["signed"]?.document;
    const proof = signed?.["proof"];
    if (signed === undefined || typeof proof !== "object" || proof === null) {
      throw new Error("fixture has no signed document");
    }
    const withProof = (changes: Record<string, unknown>) => ({
      ...signed,
      proof: { ...proof, ...changes },
    });
    expect(
      (await readIntegrityProof(withProof({ expires: "2026-11-19T11:00:00Z" }), NOW)).isErr(),
    ).toBe(true);
    expect(
      (await readIntegrityProof(withProof({ proofPurpose: "authentication" }), NOW)).isErr(),
    ).toBe(true);
    expect(
      (await readIntegrityProof(withProof({ cryptosuite: "mldsa44-jcs-2024" }), NOW)).isErr(),
    ).toBe(true);
    const { proof: _proof, ...unproved } = signed;
    expect((await readIntegrityProof(unproved, NOW))._unsafeUnwrapErr()).toEqual({
      kind: "Unproved",
    });
    const read = await readIntegrityProof(signed, NOW);
    const other = MASTODON_MULTIKEYS["rsa"]?.pem ?? "";
    expect(read.isOk() && (await verifyIntegrityProof(read.value, other))).toBe(false);
  });
});
