import { describe, expect, it } from "vite-plus/test";
import { generateAccountKeys } from "./keys";
import {
  canonicalizeJsonLd,
  ldSignedBytes,
  readLdSignature,
  signLdDocument,
  verifyLdSignature,
} from "./ld-signature";
import {
  DOCUMENTS,
  MASTODON_CANONICAL,
  MASTODON_KEY_ID,
  MASTODON_PUBLIC_KEY_PEM,
  MASTODON_SIGNED,
} from "./ld-signature.fixture";

const signedAt = (document: Readonly<Record<string, unknown>>): Date => {
  const signature: unknown = document["signature"];
  const created =
    typeof signature === "object" && signature !== null
      ? Reflect.get(signature, "created")
      : undefined;
  if (typeof created !== "string") {
    throw new Error("fixture without a signature");
  }
  return new Date(created);
};

/** Whether `body` verifies with `publicKeyPem`, as a forward is checked. */
const verifies = async (body: unknown, publicKeyPem: string, now: Date): Promise<boolean> => {
  const signed = readLdSignature(body, now);
  if (signed.isErr()) {
    return false;
  }
  const bytes = await ldSignedBytes(signed.value);
  return bytes.isOk() && verifyLdSignature(signed.value, bytes.value, publicKeyPem);
};

const mastodonSigned = (name: string): Readonly<Record<string, unknown>> => {
  const document = MASTODON_SIGNED[name];
  if (document === undefined) {
    throw new Error(`no fixture ${name}`);
  }
  return document;
};

describe("canonicalizeJsonLd", () => {
  it.each(Object.keys(DOCUMENTS))("matches Mastodon's canonical form of %s", async (name) => {
    const canonical = await canonicalizeJsonLd(DOCUMENTS[name]);
    expect(canonical._unsafeUnwrap()).toBe(MASTODON_CANONICAL[name]);
  });

  it("refuses a context it does not ship instead of fetching it", async () => {
    const canonical = await canonicalizeJsonLd({
      "@context": "https://example.com/context.jsonld",
      id: "https://example.com/1",
      type: "Note",
    });
    expect(canonical._unsafeUnwrapErr()).toEqual({ kind: "UnsupportedJsonLd" });
  });
});

describe("Mastodon's signatures", () => {
  it.each(Object.keys(MASTODON_SIGNED))("verifies %s as Mastodon signed it", async (name) => {
    const document = mastodonSigned(name);
    expect(readLdSignature(document, signedAt(document))._unsafeUnwrap().keyId).toBe(
      MASTODON_KEY_ID,
    );
    expect(await verifies(document, MASTODON_PUBLIC_KEY_PEM, signedAt(document))).toBe(true);
  });

  it("refuses a body changed after signing", async () => {
    const document = mastodonSigned("create");
    const object = document["object"];
    const tampered = {
      ...document,
      object: typeof object === "object" ? { ...object, content: "<p>forged</p>" } : object,
    };
    expect(await verifies(tampered, MASTODON_PUBLIC_KEY_PEM, signedAt(document))).toBe(false);
  });

  it("refuses an activity re-attributed to another actor", async () => {
    const document = mastodonSigned("delete");
    const tampered = { ...document, actor: "https://mastodon.example/users/mallory" };
    expect(await verifies(tampered, MASTODON_PUBLIC_KEY_PEM, signedAt(document))).toBe(false);
  });

  it("refuses signature options changed after signing", async () => {
    const document = mastodonSigned("delete");
    const signature = document["signature"];
    const tampered = {
      ...document,
      signature:
        typeof signature === "object"
          ? { ...signature, expires: "2999-01-01T00:00:00Z" }
          : signature,
    };
    expect(await verifies(tampered, MASTODON_PUBLIC_KEY_PEM, signedAt(document))).toBe(false);
  });

  it("refuses another key", async () => {
    const document = mastodonSigned("create");
    const other = await generateAccountKeys();
    expect(await verifies(document, other.publicKeyPem, signedAt(document))).toBe(false);
  });

  it("refuses an expired signature before canonicalizing", () => {
    const document = mastodonSigned("create");
    const later = new Date(signedAt(document).getTime() + 3 * 24 * 60 * 60 * 1000);
    expect(readLdSignature(document, later)._unsafeUnwrapErr()).toEqual({ kind: "Expired" });
  });
});

describe("readLdSignature", () => {
  const now = new Date("2026-11-19T00:00:00Z");
  const signature = {
    type: "RsaSignature2017",
    creator: MASTODON_KEY_ID,
    created: "2026-11-19T00:00:00Z",
    signatureValue: "AAAA",
  };

  it("refuses a body without a signature object", () => {
    expect(readLdSignature({ type: "Create" }, now)._unsafeUnwrapErr()).toEqual({
      kind: "Unsigned",
    });
    expect(readLdSignature({ signature: "x" }, now)._unsafeUnwrapErr()).toEqual({
      kind: "Unsigned",
    });
  });

  it("refuses a signature that is not a whole RsaSignature2017", () => {
    for (const other of [
      { ...signature, type: "Ed25519Signature2018" },
      { type: "RsaSignature2017", creator: MASTODON_KEY_ID },
    ]) {
      expect(readLdSignature({ signature: other }, now)._unsafeUnwrapErr()).toEqual({
        kind: "UnsupportedSignature",
      });
    }
  });

  it("refuses an expiry that does not parse", () => {
    expect(
      readLdSignature({ signature: { ...signature, expires: "soon" } }, now)._unsafeUnwrapErr(),
    ).toEqual({ kind: "Expired" });
  });

  it("refuses JSON-LD Mastodon refuses", () => {
    for (const body of [
      { signature, "@graph": [] },
      { signature, object: { "@reverse": {} } },
      { signature, tag: Array.from({ length: 1_000 }, (_, i) => i) },
    ]) {
      expect(readLdSignature(body, now)._unsafeUnwrapErr()).toEqual({
        kind: "UnsupportedJsonLd",
      });
    }
  });
});

describe("signLdDocument", () => {
  it("signs a document so that its key verifies it, as Mastodon's sign! lays it out", async () => {
    const keys = await generateAccountKeys();
    const now = new Date("2026-11-19T03:04:05.678Z");
    const document = DOCUMENTS["delete"];
    if (document === undefined) {
      throw new Error("no fixture");
    }
    const signed = (
      await signLdDocument(
        document,
        { keyId: MASTODON_KEY_ID, privateKeyJwk: keys.privateKeyJwk },
        now,
      )
    )._unsafeUnwrap();
    expect(signed["@context"]).toEqual([
      ...(Array.isArray(document["@context"]) ? document["@context"] : []),
      "https://w3id.org/security/v1",
    ]);
    expect(signed["signature"]).toMatchObject({
      type: "RsaSignature2017",
      creator: MASTODON_KEY_ID,
      created: "2026-11-19T03:04:05Z",
      expires: "2026-11-21T03:04:05Z",
    });
    expect(await verifies(signed, keys.publicKeyPem, now)).toBe(true);
  });
});
