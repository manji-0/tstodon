// Prints, as JSON, the sample activities tstodon signs
// (packages/worker/server/own-activity-samples.ts), and each one signed by
// tstodon's `signLdDocument` with a key made for this run, for
// scripts/generate-jsonld-reference.mjs to hand to Mastodon. Run with tsx.
import { generateAccountKeys } from "../packages/worker/server/keys";
import { signLdDocument } from "../packages/worker/server/ld-signature";
import { ownActivitySamples } from "../packages/worker/server/own-activity-samples";

const keyId = "https://tstodon.example/users/alice#main-key";
const keys = await generateAccountKeys();
const documents = ownActivitySamples();
const signed: Record<string, unknown> = {};
for (const [name, document] of Object.entries(documents)) {
  const result = await signLdDocument(
    document,
    { keyId, privateKeyJwk: keys.privateKeyJwk },
    new Date(),
  );
  if (result.isErr()) {
    throw new Error(`${name}: ${result.error.kind}`);
  }
  signed[name] = result.value;
}
console.log(JSON.stringify({ keyId, publicKeyPem: keys.publicKeyPem, documents, signed }));
