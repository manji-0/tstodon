import { describe, expect, it } from "vite-plus/test";
import { generateAccountKeys } from "./keys";
import { ldSignedBytes, readLdSignature, signLdDocument, verifyLdSignature } from "./ld-signature";
import { ownActivitySamples } from "./own-activity-samples";
import { MASTODON_READS, OWN_ACTIVITIES } from "./own-activity-signature.fixture";

const PUBLIC_COLLECTION = "https://www.w3.org/ns/activitystreams#Public";

/**
 * A document as Mastodon's code reads it, plain or compacted: `as_array`
 * takes a list of one as its item and an empty list as nothing, a missing
 * member reads as `null`, and the public collection may be `as:Public`.
 * The `@context` is not read.
 */
const asRead = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const items = value.map(asRead);
    return items.length === 0 ? undefined : items.length === 1 ? items[0] : items;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "@context")
        .map(([key, child]) => [key, asRead(child)])
        .filter(([, child]) => child !== null && child !== undefined),
    );
  }
  return value === PUBLIC_COLLECTION ? "as:Public" : value;
};

const mastodon = (name: string) => {
  const reading = MASTODON_READS[name];
  if (reading === undefined) {
    throw new Error(`no fixture for ${name}; run scripts/generate-jsonld-reference.mjs`);
  }
  return reading;
};

const samples = ownActivitySamples();

describe("the activities tstodon signs, as Mastodon v4.7.5 reads them", () => {
  it("are the documents the fixture was made from", () => {
    // A builder changed: run scripts/generate-jsonld-reference.mjs again.
    expect(JSON.parse(JSON.stringify(samples))).toEqual(OWN_ACTIVITIES);
  });

  it.each(Object.keys(samples))("%s reads the same signed (compacted) as plain", (name) => {
    expect(asRead(mastodon(name).read)).toEqual(asRead(samples[name]));
  });

  it.each(Object.keys(samples))("%s is safe for Mastodon to forward", (name) => {
    expect(mastodon(name).forwarded).not.toBeNull();
  });

  it.each(Object.keys(samples))(
    "%s carries a signature Mastodon's verify_actor! accepts",
    (name) => {
      expect(mastodon(name).verified).toBe(true);
    },
  );

  it.each(Object.keys(samples))("%s, signed, passes tstodon's own forward check", async (name) => {
    const document = samples[name];
    if (document === undefined) {
      throw new Error(name);
    }
    const keys = await generateAccountKeys();
    const now = new Date("2026-11-19T00:00:00Z");
    const signed = await signLdDocument(
      document,
      { keyId: "https://tstodon.example/users/alice#main-key", privateKeyJwk: keys.privateKeyJwk },
      now,
    );
    const read = readLdSignature(signed._unsafeUnwrap(), now)._unsafeUnwrap();
    const bytes = await ldSignedBytes(read);
    expect(bytes.isOk() && (await verifyLdSignature(read, bytes.value, keys.publicKeyPem))).toBe(
      true,
    );
  });
});
