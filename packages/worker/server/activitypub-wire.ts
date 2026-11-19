import { schemaResult, warmSchemas } from "@tstodon/core";
import { z } from "zod";
import { booleanish } from "./form-values";

export const JsonObjectSchema = z.record(z.string(), z.unknown());

const ObjectReferenceSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1) }).passthrough(),
]);

const parseRef = schemaResult(ObjectReferenceSchema);

/**
 * The id a property names, as Mastodon's `value_or_id(as_array(value).first)`:
 * a URI, or the `id` of an embedded object, the first one of a list.
 */
export const refId = (value: unknown): string | undefined => {
  const parsed = parseRef(Array.isArray(value) ? value[0] : value);
  if (parsed.isErr()) {
    return undefined;
  }
  return typeof parsed.value === "string" ? parsed.value : parsed.value.id;
};

export const ActivityJsonSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    actor: z.string().min(1),
    /**
     * One object. A list (a `Flag` names the reported account and posts) is
     * read as its first entry here; a handler that needs them all reads the
     * raw activity.
     */
    object: z.union([
      ObjectReferenceSchema,
      z.tuple([ObjectReferenceSchema], ObjectReferenceSchema).transform(([first]) => first),
    ]),
  })
  .passthrough();

const CollectionActivitySchema = z.looseObject({
  type: z.literal(["Add", "Remove"]),
  actor: z.string().min(1),
});

/** A featured hashtag as an `Add` or `Remove` carries it: no `id`, its page as `href`. */
const HashtagObjectSchema = z.looseObject({
  type: z.literal("Hashtag"),
  href: z.string().min(1),
});

const parseCollectionActivity = schemaResult(CollectionActivitySchema);
const parseHashtagObject = schemaResult(HashtagObjectSchema);

/** Whether an activity's `object` is a `Hashtag`, as a featured hashtag's `Add` carries. */
export const isHashtagObject = (object: unknown): boolean => parseHashtagObject(object).isOk();

/**
 * Mastodon sends `Add` and `Remove` (a pin, an unpin, a featured hashtag)
 * without an `id` (`AddNoteSerializer`, `AddHashtagSerializer`), and a
 * `Hashtag` object has none either. The inbox claims every activity by its
 * id and reads every object by one, so:
 *
 * - an activity without an `id` is named after the signed request that
 *   carries it, its `Date` and `Digest`: a redelivery of the same request is
 *   then a duplicate, and a later pin of the same note, signed at another
 *   time, is not;
 * - a `Hashtag` object without an `id` is named by its `href`.
 *
 * A known limit: a pin, an unpin and a pin again of one note, all signed in
 * the same second, send two `Add`s that are the same bytes (the body, the
 * `Date`, and so the signature), and the second is taken for a redelivery of
 * the first. Nothing in the request tells them apart, so telling them apart
 * would mean applying a replayed request. The next read of the actor's
 * `featured` collection corrects the pin.
 */
export const nameCollectionActivity = (
  json: unknown,
  date: string | undefined,
  digest: string | undefined,
): unknown => {
  const activity = parseCollectionActivity(json);
  if (activity.isErr()) {
    return json;
  }
  const { actor, type, object } = activity.value;
  const hashtag = parseHashtagObject(object);
  return {
    ...activity.value,
    ...(activity.value.id === undefined && date && digest
      ? { id: `${actor}#${type.toLowerCase()}/${date}/${digest}` }
      : {}),
    ...(hashtag.isOk() && hashtag.value.id === undefined
      ? { object: { ...hashtag.value, id: hashtag.value.href } }
      : {}),
  };
};

/**
 * The activity an `Undo` embeds: its `id`, and its `type` and `object` when
 * given. Mastodon reads one without a `type` as named by its `id` only.
 */
export const UndoneActivitySchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1).optional(),
  object: z.unknown().optional(),
});

export const ActorPublicKeySchema = z.object({
  id: z.string().min(1),
  owner: z.string().min(1),
  publicKeyPem: z.string().min(1),
});

export const ActorDocumentSchema = z
  .object({
    id: z.string().min(1),
    preferredUsername: z.string().min(1),
    inbox: z.string().min(1),
    outbox: z.string().min(1).optional(),
    featured: z.string().min(1).optional(),
    featuredTags: z.string().min(1).optional(),
    /** Its `followers` / `following` collections: a URI, an object with an id, or a list of them. */
    followers: z.unknown().optional(),
    following: z.unknown().optional(),
    publicKey: ActorPublicKeySchema,
    name: z.string().optional(),
    endpoints: z
      .object({
        sharedInbox: z.string().min(1).optional(),
      })
      .optional(),
    type: z.string().optional(),
    summary: z.string().nullable().optional(),
    url: z.unknown().optional(),
    icon: z.unknown().optional(),
    image: z.unknown().optional(),
    manuallyApprovesFollowers: z.boolean().nullable().optional(),
    published: z.string().nullable().optional(),
    /** Its profile fields, among other attachments; read leniently (`remote-actor-fields.ts`). */
    attachment: z.unknown().optional(),
    /** The accounts this one says it is also: a list, or a single URI. */
    alsoKnownAs: z.union([z.string(), z.array(z.string())]).optional(),
    /** The account this one says it moved to. */
    movedTo: z.string().min(1).nullable().optional(),
  })
  .passthrough();

export const RemoteWebfingerSchema = z
  .object({
    subject: z.string().optional(),
    links: z
      .array(
        z.object({
          rel: z.string(),
          type: z.string().optional(),
          href: z.string().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

const PollOptionDocumentSchema = z
  .object({
    name: z.string(),
    replies: z.object({ totalItems: z.number().int().nonnegative() }).partial().optional(),
  })
  .passthrough();

/** The object types Mastodon stores as they are (`ActivityPub::Activity::SUPPORTED_TYPES`). */
const SUPPORTED_NOTE_TYPES = ["Note", "Question"] as const;

/**
 * The object types Mastodon stores as a status that links to the object
 * (`ActivityPub::Activity::CONVERTED_TYPES`): its text is the object's name,
 * summary and link, and its content is dropped (`StatusParser#processed_text`).
 */
export const CONVERTED_OBJECT_TYPES = [
  "Image",
  "Audio",
  "Video",
  "Article",
  "Page",
  "Event",
] as const;

/** Whether an object of `type` is stored as a status, as it is or converted. */
export const isStatusObjectType = (type: string): boolean =>
  SUPPORTED_NOTE_TYPES.some((supported) => supported === type) ||
  CONVERTED_OBJECT_TYPES.some((converted) => converted === type);

/** A property's id: a URI, an object with an `id`, or the first of a list of them. */
const ObjectIdSchema = z.unknown().transform(refId).pipe(z.string().min(1));

const NoteFields = {
  id: z.string().min(1),
  oneOf: z.array(PollOptionDocumentSchema).optional(),
  anyOf: z.array(PollOptionDocumentSchema).optional(),
  endTime: z.string().nullable().optional(),
  closed: z.union([z.string(), z.boolean()]).nullable().optional(),
  votersCount: z.number().int().nonnegative().nullable().optional(),
  /** The author: Mastodon reads the first entry (PeerTube lists the account, then the channel). */
  attributedTo: ObjectIdSchema,
  /** The content per language; Mastodon sends one entry, keyed by the post's language. */
  contentMap: z.record(z.string(), z.unknown()).optional(),
  /** The title of a converted object; any other value is no title. */
  name: z.unknown().optional(),
  nameMap: z.record(z.string(), z.unknown()).optional(),
  summaryMap: z.record(z.string(), z.unknown()).optional(),
  published: z.string().min(1),
  updated: z.string().nullable().optional(),
  /** A URI, a `Link`, or a list of either; read as Mastodon's `url_to_href`. */
  url: z.unknown().optional(),
  to: z.union([z.string(), z.array(z.string())]).optional(),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  sensitive: booleanish,
  summary: z.string().nullable().optional(),
  inReplyTo: z.string().nullable().optional(),
  attachment: z
    .array(
      z.object({
        type: z.string().optional(),
        mediaType: z.string().optional(),
        url: z.string().optional(),
        name: z.string().nullable().optional(),
        // Read leniently (`remote-attachment.ts`): a malformed one is left out, and the note is kept.
        blurhash: z.unknown().optional(),
        width: z.unknown().optional(),
        height: z.unknown().optional(),
        focalPoint: z.unknown().optional(),
      }),
    )
    .optional(),
  /** FEP-044f / GoToSocial interaction policy; read leniently, a malformed one is no policy. */
  interactionPolicy: z.unknown().optional(),
};

/**
 * A `Note`, a `Question` (a note with poll options), or an object of a
 * {@link CONVERTED_OBJECT_TYPES} type, whose content is not read.
 */
export const NoteDocumentSchema = z.discriminatedUnion("type", [
  z.looseObject({
    ...NoteFields,
    type: z.literal(SUPPORTED_NOTE_TYPES),
    content: z.string(),
  }),
  z.looseObject({
    ...NoteFields,
    type: z.literal(CONVERTED_OBJECT_TYPES),
  }),
]);

/**
 * A poll vote as Mastodon sends it: a `Note` named for the chosen option,
 * answering the poll's note, with no content of its own.
 */
export const PollVoteDocumentSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("Note"),
    attributedTo: z.string().min(1),
    name: z.string().min(1),
    inReplyTo: z.string().min(1),
    content: z.string().nullable().optional(),
  })
  .passthrough();

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([
  JsonObjectSchema,
  ActivityJsonSchema,
  CollectionActivitySchema,
  HashtagObjectSchema,
  UndoneActivitySchema,
  ActorPublicKeySchema,
  ActorDocumentSchema,
  NoteDocumentSchema,
  PollVoteDocumentSchema,
]);
