import {
  Collection,
  InstanceIdentity,
  LocalAccount,
  type LocalNote,
  type LocalReblog,
  LocalStatus,
} from "@tstodon/domain";
import type { ApActivityDocumentJSON } from "@tstodon/api/activitypub";
import {
  actorDeleteActivity,
  actorDocument,
  actorUpdateActivity,
  announceActivity,
  featuredTagActivity,
  hashtagObject,
  localNoteRef,
  noteDeleteActivity,
  noteCreateActivity,
  noteDocument,
  noteUpdateActivity,
  quoteRequestActivity,
  undoActivity,
} from "./activitypub";
import {
  localQuoteAuthorization,
  quoteAuthorizationDeleteActivity,
} from "./quote-authorization-document";
import type { CustomEmoji } from "./emoji";
import { type CollectionEvent, collectionActivity } from "./collection-federation";

/*
 * One of each activity tstodon signs, built by the builders that send them,
 * with every optional part a document can carry. The JSON-LD audit runs
 * Mastodon's own compaction over these (scripts/generate-jsonld-reference.mjs),
 * and `own-activity-signature.test.ts` holds the builders to that fixture.
 */

const identity = InstanceIdentity.parse({
  kind: "InstanceIdentity",
  domain: "tstodon.example",
  publicOrigin: "https://tstodon.example",
  name: "tstodon",
  description: "samples",
  sourceUrl: "https://github.com/example/tstodon",
  languages: ["en"],
  contactEmail: "admin@tstodon.example",
  thumbnailUrl: "https://tstodon.example/thumbnail.png",
  mediaPublicBaseUrl: "https://media.tstodon.example/",
})._unsafeUnwrap();

const alice = LocalAccount.schema.parse({
  kind: "LocalAccount",
  id: "01J00000000000000000000001",
  username: "alice",
  accessEmail: "alice@tstodon.example",
  displayName: "Alice :blob:",
  locked: true,
  defaultPostVisibility: { kind: "Public" },
  defaultQuotePolicy: { kind: "Public" },
  publicKeyPem:
    "-----BEGIN PUBLIC KEY-----\nMFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAL\n-----END PUBLIC KEY-----\n",
  privateKeyJwk: "{}",
  createdAt: "2026-01-02T03:04:05.000Z",
});

const MASTODON_ALICE = "https://mastodon.example/users/alice";
const blob: CustomEmoji = {
  shortcode: "blob",
  url: "https://media.tstodon.example/emoji/1.png",
  static_url: "https://media.tstodon.example/emoji/1.png",
  visible_in_picker: true,
  source: {
    kind: "Uploaded",
    id: "1",
    updatedAt: "2026-01-02T03:04:05Z",
    contentType: "image/png",
  },
};

const note = (fields: Readonly<Record<string, unknown>>): LocalNote => {
  const parsed = LocalStatus.schema.parse({
    kind: "LocalNote",
    id: "01J00000000000000000000010",
    accountId: alice.id,
    text: "@alice@mastodon.example héllo :blob: #Tag 日本語",
    contentHtml:
      '<p><span class="h-card"><a href="https://mastodon.example/@alice" class="u-url mention">@<span>alice</span></a></span> héllo :blob: <a href="https://tstodon.example/tags/Tag" class="mention hashtag" rel="tag">#<span>Tag</span></a> 日本語 &amp; &quot;q&quot;</p>',
    visibility: { kind: "Public" },
    spoilerText: "",
    sensitive: false,
    language: { kind: "None" },
    quote: { kind: "None" },
    mediaIds: [],
    poll: { kind: "None" },
    inReplyToId: null,
    createdAt: "2026-11-19T00:00:00.000Z",
    editedAt: null,
    ...fields,
  });
  if (parsed.kind !== "LocalNote") {
    throw new Error("sample note");
  }
  return parsed;
};

const reblog = (visibility: LocalReblog["visibility"]): LocalReblog => {
  const parsed = LocalStatus.schema.parse({
    kind: "LocalReblog",
    id: "01J00000000000000000000020",
    accountId: alice.id,
    target: { kind: "RemoteStatus", statusId: "01J00000000000000000000099" },
    visibility,
    createdAt: "2026-11-19T00:00:00.000Z",
  });
  if (parsed.kind !== "LocalReblog") {
    throw new Error("sample reblog");
  }
  return parsed;
};

const media = {
  attachments: [
    {
      mediaType: "image/png",
      url: "https://media.tstodon.example/media/1.png",
      name: "A described image",
      blurhash: "UABCDEFGHIJ00000000000000000",
      focalPoint: [0.25, -0.5] as const,
      dimensions: { width: 640, height: 480 },
    },
    {
      mediaType: "video/mp4",
      url: "https://media.tstodon.example/media/2.mp4",
      name: null,
      blurhash: null,
      focalPoint: [0, 1] as const,
      dimensions: undefined,
    },
  ],
  authorSensitized: false,
};
const noMedia = { attachments: [], authorSensitized: false };

/** A public reply with media, mentions, a hashtag, emoji, a content warning and an accepted quote. */
const richNote = noteDocument(
  identity,
  alice,
  note({ spoilerText: "cw :blob:", sensitive: true }),
  {
    quote: {
      uri: `${MASTODON_ALICE}/statuses/7`,
      authorization: `${MASTODON_ALICE}/quote_authorizations/9`,
      addressAuthor: MASTODON_ALICE,
    },
    mentions: [{ href: MASTODON_ALICE, name: "@alice@mastodon.example" }],
    reply: { inReplyTo: `${MASTODON_ALICE}/statuses/6`, addressAuthor: MASTODON_ALICE },
    media,
    quotePolicy: "public",
    emojis: [blob],
  },
);

const poll = (multiple: boolean, closed: boolean) => ({
  id: "01J00000000000000000000030",
  statusId: "01J00000000000000000000011",
  multiple,
  expiresAt: closed ? "2026-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z",
  hideTotals: false,
  options: [
    { title: "this :blob:", votesCount: 2 },
    { title: "that", votesCount: 0 },
  ],
  votersCount: 2,
  votedIndexes: [],
});

/** An unlisted poll, without media or quote, quotable by followers. */
const question = noteDocument(
  identity,
  alice,
  note({
    id: "01J00000000000000000000011",
    text: "which?",
    contentHtml: "<p>which?</p>",
    visibility: { kind: "Unlisted" },
    poll: { kind: "Present" },
  }),
  { poll: poll(false, false), media: noMedia, quotePolicy: "followers", emojis: [blob] },
);

const editedNote = noteDocument(identity, alice, note({ editedAt: "2026-11-19T01:00:00.000Z" }), {
  media: noMedia,
  quotePolicy: "nobody",
  emojis: [],
});

const closedPoll = noteDocument(
  identity,
  alice,
  note({ text: "both?", contentHtml: "<p>both?</p>", poll: { kind: "Present" } }),
  { poll: poll(true, true), media: noMedia, quotePolicy: "public", emojis: [] },
);

const fullActor = actorDocument(
  identity,
  alice,
  { alsoKnownAs: [MASTODON_ALICE], movedTo: MASTODON_ALICE },
  {
    kind: "Shown",
    profile: {
      note: "bio :blob: with <html> & more",
      fields: [
        { name: "site", value: "https://tstodon.example/@alice" },
        { name: "pronouns", value: "she/her" },
      ],
      bot: true,
      discoverable: true,
      indexable: false,
      hideCollections: false,
      avatarObjectKey: "avatars/1.png",
      avatarContentType: "image/png",
      headerObjectKey: "headers/1.jpg",
      headerContentType: null,
    },
    emojis: [blob],
    fieldMentions: [],
  },
);

const actorUri = InstanceIdentity.actorUrl(identity, alice.username);
const boosted = { uri: `${MASTODON_ALICE}/statuses/5`, authorUri: MASTODON_ALICE };
const stamp = localQuoteAuthorization(
  localNoteRef(identity, alice, "01J00000000000000000000010"),
  "01J00000000000000000000040",
  `${MASTODON_ALICE}/statuses/8`,
);

/** Each sample activity by name. */
/** A collection alice made, featuring herself, as `collectionActivity` sends it. */
const curated = Collection.parse({
  kind: "LocalCollection",
  id: "01J00000000000000000000100",
  accountId: alice.id,
  name: "Good people",
  description: "Follow them",
  language: "en",
  sensitive: false,
  discoverable: true,
  tagName: "people",
  createdAt: "2026-11-19T04:00:00.000Z",
  updatedAt: "2026-11-19T05:00:00.000Z",
  items: [
    {
      id: "01J00000000000000000000101",
      accountId: alice.id,
      position: 1,
      state: "accepted",
      createdAt: "2026-11-19T04:00:00.000Z",
    },
  ],
})._unsafeUnwrap();

const curatedItem = curated.items[0];

const collectionSample = (event: CollectionEvent): ApActivityDocumentJSON => {
  const activity = collectionActivity(identity, alice, event, (accountId) =>
    accountId === alice.id ? actorUri : undefined,
  );
  if (activity === undefined) {
    throw new Error(`no ${event.kind} sample`);
  }
  return activity;
};

export const ownActivitySamples = (): Readonly<Record<string, ApActivityDocumentJSON>> => ({
  createRichNote: noteCreateActivity(identity, alice, richNote),
  createQuestion: noteCreateActivity(identity, alice, question),
  updateNote: noteUpdateActivity(
    editedNote,
    "01J00000000000000000000050",
    "2026-11-19T01:00:00.000Z",
  ),
  updateClosedPoll: noteUpdateActivity(
    closedPoll,
    "01J00000000000000000000051",
    "2026-11-19T02:00:00.000Z",
  ),
  announcePublic: announceActivity(identity, alice, reblog({ kind: "Public" }), boosted),
  announceUnlisted: announceActivity(identity, alice, reblog({ kind: "Unlisted" }), boosted),
  undoAnnounce: undoActivity(
    announceActivity(identity, alice, reblog({ kind: "Public" }), boosted),
  ),
  deleteNote: noteDeleteActivity(richNote),
  updateActor: actorUpdateActivity(
    fullActor,
    "01J00000000000000000000060",
    "2026-11-19T03:00:00.000Z",
  ),
  updateSuspendedActor: actorUpdateActivity(
    actorDocument(identity, alice, { alsoKnownAs: [] }, { kind: "Suspended" }),
    "01J00000000000000000000061",
    "2026-11-19T03:00:00.000Z",
  ),
  deleteActor: actorDeleteActivity(actorUri, "01J00000000000000000000070"),
  addHashtag: featuredTagActivity(
    "Add",
    actorUri,
    hashtagObject(identity, "Tag"),
    "01J00000000000000000000080",
  ),
  removeHashtag: featuredTagActivity(
    "Remove",
    actorUri,
    hashtagObject(identity, "Tag"),
    "01J00000000000000000000081",
  ),
  quoteRequest: quoteRequestActivity(
    `${actorUri}/quote_requests/01J00000000000000000000090`,
    actorUri,
    `${MASTODON_ALICE}/statuses/7`,
    richNote,
  ),
  deleteQuoteAuthorization: quoteAuthorizationDeleteActivity(stamp),
  addFeaturedCollection: collectionSample({ kind: "Created", collection: curated }),
  updateFeaturedCollection: collectionSample({ kind: "Updated", collection: curated }),
  removeFeaturedCollection: collectionSample({ kind: "Deleted", collection: curated }),
  ...(curatedItem
    ? {
        addFeaturedItem: collectionSample({
          kind: "ItemAdded",
          collection: curated,
          item: curatedItem,
        }),
        removeFeaturedItem: collectionSample({
          kind: "ItemRemoved",
          collection: curated,
          item: curatedItem,
        }),
        deleteFeatureAuthorization: collectionSample({
          kind: "ItemRevoked",
          collection: curated,
          item: curatedItem,
          featured: alice,
        }),
      }
    : {}),
});
