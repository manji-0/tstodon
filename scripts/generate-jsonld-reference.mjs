#!/usr/bin/env node
// Writes packages/worker/server/jsonld-contexts.ts, the JSON-LD contexts the
// Worker canonicalizes with (it never fetches one), and
// packages/worker/server/ld-signature.fixture.ts, what Mastodon makes of a
// set of documents: their canonical N-Quads and their Linked Data signature.
// `ld-signature.test.ts` holds `server/ld-signature.ts` to both. Run once per
// Mastodon release; the tests need no Ruby. It runs
// scripts/jsonld-reference.rb in the Mastodon image (Docker):
//
//   node scripts/generate-jsonld-reference.mjs && pnpm fmt
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const image = process.env.MASTODON_IMAGE ?? "ghcr.io/mastodon/mastodon:v4.7.5";

const AS = "https://www.w3.org/ns/activitystreams";
const PUBLIC = `${AS}#Public`;
const alice = "https://mastodon.example/users/alice";
const note = `${alice}/statuses/110`;
const mastodonContext = [
  AS,
  {
    ostatus: "http://ostatus.org#",
    atomUri: "ostatus:atomUri",
    inReplyToAtomUri: "ostatus:inReplyToAtomUri",
    conversation: "ostatus:conversation",
    sensitive: "as:sensitive",
    toot: "http://joinmastodon.org/ns#",
    votersCount: "toot:votersCount",
    Hashtag: "as:Hashtag",
    Emoji: "toot:Emoji",
    focalPoint: { "@container": "@list", "@id": "toot:focalPoint" },
    blurhash: "toot:blurhash",
    quote: { "@id": "https://w3id.org/fep/044f#quote", "@type": "@id" },
    gts: "https://gotosocial.org/ns#",
    interactionPolicy: { "@id": "gts:interactionPolicy", "@type": "@id" },
    canQuote: { "@id": "gts:canQuote", "@type": "@id" },
    automaticApproval: { "@id": "gts:automaticApproval", "@type": "@id" },
  },
];
const noteObject = {
  id: note,
  type: "Note",
  summary: null,
  inReplyTo: "https://tstodon.example/users/bob/statuses/1",
  published: "2026-11-19T00:00:00Z",
  url: "https://mastodon.example/@alice/110",
  attributedTo: alice,
  to: [PUBLIC],
  cc: [`${alice}/followers`, "https://tstodon.example/users/bob"],
  sensitive: false,
  atomUri: note,
  inReplyToAtomUri: "https://tstodon.example/users/bob/statuses/1",
  conversation: "tag:mastodon.example,2026-11-19:objectId=1:objectType=Conversation",
  content:
    '<p><span class="h-card"><a href="https://tstodon.example/@bob">@bob</a></span> héllo :blob: #tag "q" &amp; 日本語 😀</p>',
  contentMap: { en: "<p>héllo</p>" },
  attachment: [
    {
      type: "Document",
      mediaType: "image/png",
      url: "https://mastodon.example/media/1.png",
      name: null,
      blurhash: "UABC",
      focalPoint: [0.0, 0.5],
      width: 10,
      height: 20,
    },
  ],
  tag: [
    { type: "Mention", href: "https://tstodon.example/users/bob", name: "@bob@tstodon.example" },
    { type: "Hashtag", href: "https://mastodon.example/tags/tag", name: "#tag" },
    {
      id: "https://mastodon.example/emojis/1",
      type: "Emoji",
      name: ":blob:",
      updated: "2026-01-01T00:00:00Z",
      icon: { type: "Image", mediaType: "image/png", url: "https://mastodon.example/e/blob.png" },
    },
  ],
  replies: {
    id: `${note}/replies`,
    type: "Collection",
    first: {
      type: "CollectionPage",
      next: `${note}/replies?page=true`,
      partOf: `${note}/replies`,
      items: [],
    },
  },
  interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } },
};

/** The documents Mastodon canonicalizes and signs, by name. */
const documents = {
  create: {
    "@context": mastodonContext,
    id: `${note}/activity`,
    type: "Create",
    actor: alice,
    published: "2026-11-19T00:00:00Z",
    to: [PUBLIC],
    cc: noteObject.cc,
    object: noteObject,
  },
  update: {
    "@context": mastodonContext,
    id: `${note}#updates/1763510400`,
    type: "Update",
    actor: alice,
    published: "2026-11-19T01:00:00Z",
    to: [PUBLIC],
    cc: noteObject.cc,
    object: { ...noteObject, content: "<p>edited</p>", updated: "2026-11-19T01:00:00Z" },
  },
  delete: {
    "@context": [AS, { ostatus: "http://ostatus.org#", atomUri: "ostatus:atomUri" }],
    id: `${note}#delete`,
    type: "Delete",
    actor: alice,
    to: [PUBLIC],
    object: { id: note, type: "Tombstone", atomUri: note },
  },
  // Terms no context defines, a relative IRI and control characters: Mastodon
  // drops the first two, and the signature must agree on what is left.
  undefinedTerms: {
    "@context": ["http://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
    id: "https://misskey.example/notes/abc/activity",
    type: "Create",
    actor: "https://misskey.example/users/x",
    object: {
      id: "https://misskey.example/notes/abc",
      type: "Note",
      attributedTo: "https://misskey.example/users/x",
      content: "<p>a\u0001b   \\ \t 😀</p>",
      _misskey_content: "a",
      relative: "not/an/iri",
      to: [PUBLIC],
    },
    to: [PUBLIC],
  },
};

const run = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-i",
    "-v",
    `${path("./jsonld-reference.rb")}:/reference.rb:ro`,
    "--entrypoint",
    "sh",
    image,
    "-c",
    "cd /opt/mastodon && bundle exec ruby /reference.rb 2>/dev/null",
  ],
  {
    input: JSON.stringify({ keyId: `${alice}#main-key`, documents }),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
);
if (run.status !== 0) {
  process.stderr.write(run.stderr);
  process.exit(run.status ?? 1);
}
const reference = JSON.parse(run.stdout);

const header = (purpose) =>
  `// Generated by scripts/generate-jsonld-reference.mjs from ${image}; do not edit.\n// ${purpose}\n`;

writeFileSync(
  path("../packages/worker/server/jsonld-contexts.ts"),
  `${header("The JSON-LD contexts Mastodon preloads, as its processor holds them.")}
/** Each context by URL. Mastodon also preloads each under \`http://\`. */
export const JSONLD_CONTEXTS: ReadonlyMap<string, Readonly<Record<string, unknown>>> = new Map<
  string,
  Readonly<Record<string, unknown>>
>(${JSON.stringify(Object.entries(reference.contexts))});

/** \`ContextHelper#full_context\`: what Mastodon compacts a signed activity to before it reads it. */
export const MASTODON_FULL_CONTEXT: ReadonlyArray<unknown> = ${JSON.stringify(reference.fullContext)};
`,
);

writeFileSync(
  path("../packages/worker/server/ld-signature.fixture.ts"),
  `${header("What Mastodon makes of the documents in the script: canonical N-Quads, and its Linked Data signature with a key made for the run.")}
export const MASTODON_KEY_ID = ${JSON.stringify(`${alice}#main-key`)};

export const MASTODON_PUBLIC_KEY_PEM = ${JSON.stringify(reference.publicKeyPem)};

/** Each document, unsigned, by name. */
export const DOCUMENTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = ${JSON.stringify(documents)};

/** \`JsonLdHelper#canonicalize\` of each document. */
export const MASTODON_CANONICAL: Readonly<Record<string, string>> = ${JSON.stringify(reference.canonical)};

/** \`ActivityPub::LinkedDataSignature#sign!\` of each document. */
export const MASTODON_SIGNED: Readonly<Record<string, Readonly<Record<string, unknown>>>> = ${JSON.stringify(reference.signed)};
`,
);
console.log("wrote server/jsonld-contexts.ts and server/ld-signature.fixture.ts");
