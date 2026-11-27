#!/usr/bin/env node
// Writes packages/worker/server/key-forms.fixture.ts: what Mastodon makes of
// remote usernames, FEP-521a `publicKeyMultibase` values, JCS documents and
// FEP-8b32 `eddsa-jcs-2022` proofs. `key-forms.test.ts` holds tstodon to it.
// Run once per Mastodon release; the tests need no Ruby. It runs
// scripts/key-forms-reference.rb in the Mastodon image (Docker):
//
//   node scripts/generate-key-forms-reference.mjs && pnpm fmt
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const image = process.env.MASTODON_IMAGE ?? "ghcr.io/mastodon/mastodon:v4.7.6";

const AS = "https://www.w3.org/ns/activitystreams";
const DATA_INTEGRITY = "https://w3id.org/security/data-integrity/v1";
const PUBLIC = `${AS}#Public`;
const alice = "https://fep.example/users/alice";
const verificationMethod = `${alice}#ed25519-key`;

const create = (context) => ({
  "@context": context,
  id: `${alice}/statuses/1/activity`,
  type: "Create",
  actor: alice,
  published: "2026-11-19T00:00:00Z",
  to: [PUBLIC],
  cc: [`${alice}/followers`],
  object: {
    id: `${alice}/statuses/1`,
    type: "Note",
    attributedTo: alice,
    content: '<p>héllo "q" &amp; 日本語 😀</p>',
    published: "2026-11-19T00:00:00Z",
    to: [PUBLIC],
    cc: [`${alice}/followers`],
  },
});

const signed = create([AS, DATA_INTEGRITY]);

/** Numbers JCS writes differently from `JSON.stringify`, as Mastodon's gem writes them. */
const numbers = {
  "@context": [AS, DATA_INTEGRITY],
  id: `${alice}/numbers`,
  type: "Note",
  attributedTo: alice,
  values: [
    0,
    -0,
    1,
    -1,
    1.5,
    0.1,
    100,
    1e21,
    1e-7,
    1e-6,
    123456789,
    1.23e-5,
    3.14159,
    0.30000000000000004,
    12345678901234567890,
    9007199254740993,
    5e-324,
    1.7976931348623157e308,
    2 ** 53,
    0.000001234,
    123.456,
    1e20,
    1.5e20,
    4.35,
    333333333.33333329,
  ],
};

/** Member names and strings whose order and escapes JCS fixes. */
const strings = {
  "@context": [AS, DATA_INTEGRITY],
  id: `${alice}/strings`,
  type: "Note",
  attributedTo: alice,
  é: 1,
  "\u{1f600}": 2,
  "�": 3,
  B: 4,
  a: 5,
  "\u0080": 6,
  "ÿ\u0001": 7,
  content: 'tab\tnl\ncr\rbs\bff\fnul\u0000us\u001fdel\u007fls ps  </script> "q" \\ / 😀',
  nested: { z: [true, false, null, { y: "", x: [] }], a: {} },
};

const usernames = [
  "alice",
  "Alice_2",
  "a.b",
  "a-b",
  "a..b",
  "a.-_b",
  "_",
  "x",
  ".alice",
  "alice.",
  "-alice",
  "alice-",
  "al ice",
  "alice@fep.example",
  "josé",
  "アリス",
  "a/b",
  "alice\n",
  "",
];

const proofs = {
  // A proof whose options name no context.
  signed: { document: signed },
  // `proofValue` in base64url (`u`), which Mastodon's Multibase also reads.
  base64Url: { document: signed, proofValueBase: "u" },
  // The content changed after signing.
  tampered: { document: signed, after: { object: { content: "<p>changed</p>" } } },
  // A Linked Data signature added: Mastodon checks the proof without it.
  withSignature: {
    document: signed,
    after: { signature: { type: "RsaSignature2017", creator: `${alice}#main-key` } },
  },
  // The proof names the document's whole context.
  proofContext: { document: signed, proofContext: [AS, DATA_INTEGRITY] },
  // The proof names the first entries of the document's context: the hash
  // covers the document with only those.
  proofContextPrefix: {
    document: create([AS, DATA_INTEGRITY, { toot: "http://joinmastodon.org/ns#" }]),
    proofContext: [AS, DATA_INTEGRITY],
  },
  // A context entry added after signing, after the proof's.
  contextExtended: {
    document: signed,
    proofContext: [AS, DATA_INTEGRITY],
    contextAfter: [AS, DATA_INTEGRITY, { content: null }],
  },
  // A context entry added after signing, with none in the proof.
  contextChanged: { document: signed, contextAfter: [AS, DATA_INTEGRITY, { content: null }] },
  // The proof's context is a string: Mastodon reads it as not a prefix.
  proofContextString: { document: create(AS), proofContext: AS },
  // The proof's context is not the start of the document's.
  proofContextMismatch: { document: signed, proofContext: [DATA_INTEGRITY] },
  numbers: { document: numbers },
  strings: { document: strings },
};

const multikeys = {
  // secp256k1-pub (0xe7), a codec Mastodon does not read.
  unknownCodec: "zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme",
  // A character base58btc does not have (`0`).
  badCharacter: "z6Mk0000",
  // A base Mastodon does not read (`f`, hex).
  badBase: "fed01",
  // Base64url `Base64.urlsafe_decode64` refuses: a character it lacks, a
  // padded value of the wrong length, and bits left over after the last byte.
  badBase64Url: "u!!!!",
  badBase64UrlPadding: "uAA=",
  badBase64UrlTrailingBits: "u7QHaixYIunaqSxV7zm3RdF6ztjt-G4A2mE4C-kr4XiH77B",
  // `+` and `/`, which `urlsafe_decode64` reads too.
  base64UrlStandardAlphabet: "u7QHaixYIunaqSxV7zm3RdF6ztjt+G4A2mE4C+kr4XiH77A",
  // Nothing after the base.
  emptyBase58: "z",
  empty: "",
};

const run = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-i",
    "-v",
    `${path("./key-forms-reference.rb")}:/reference.rb:ro`,
    "--entrypoint",
    "sh",
    image,
    "-c",
    "cd /opt/mastodon && bundle exec ruby /reference.rb",
  ],
  {
    input: JSON.stringify({
      verificationMethod,
      usernames,
      multikeys,
      documents: { numbers, strings, signed },
      proofs,
    }),
    maxBuffer: 64 * 1024 * 1024,
  },
);
if (run.status !== 0) {
  process.stderr.write(run.stderr);
  process.exit(run.status ?? 1);
}
const reference = JSON.parse(run.stdout);

writeFileSync(
  path("../packages/worker/server/key-forms.fixture.ts"),
  `// Generated by scripts/generate-key-forms-reference.mjs from ${image}; do not edit.
// What Mastodon makes of remote usernames, FEP-521a keys and FEP-8b32 proofs, with an Ed25519 key made for the run.

/** The key id the proofs name. */
export const PROOF_VERIFICATION_METHOD = ${JSON.stringify(verificationMethod)};

/** The actor the proofs are made for. */
export const PROOF_ACTOR = ${JSON.stringify(alice)};

/** Whether \`Account::USERNAME_ONLY_RE\` matches each username. */
export const MASTODON_USERNAMES: Readonly<Record<string, boolean>> = ${JSON.stringify(reference.usernames)};

/** \`Multibase.decode_key_to_pem\` of each \`publicKeyMultibase\`: its key, or the error it raises. */
export const MASTODON_MULTIKEYS: Readonly<
  Record<string, Readonly<{ multibase: string; type?: string; pem?: string; error?: string }>>
> = ${JSON.stringify(reference.multikeys)};

/** Each document as given, by name. */
export const JCS_DOCUMENTS: Readonly<Record<string, unknown>> = ${JSON.stringify({ numbers, strings, signed })};

/** \`to_json_c14n\` of each document. */
export const MASTODON_JCS: Readonly<Record<string, string>> = ${JSON.stringify(reference.canonical)};

/** Each proved document, and whether \`verify_eddsa_jcs_2022\` accepts it without its \`signature\`. */
export const MASTODON_PROOFS: Readonly<
  Record<string, Readonly<{ document: Readonly<Record<string, unknown>>; verified: boolean }>>
> = ${JSON.stringify(reference.proofs)};
`,
);
console.log("wrote server/key-forms.fixture.ts");
