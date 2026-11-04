import { warmSchemas } from "@tstodon/core";
import { z } from "zod";
import { booleanish } from "./form-values";

export const JsonObjectSchema = z.record(z.string(), z.unknown());

const ObjectReferenceSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1) }).passthrough(),
]);

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

export const NestedActivityObjectSchema = z
  .object({
    type: z.string().min(1),
    object: z.union([z.string().min(1), z.object({ id: z.string().min(1) }).passthrough()]),
  })
  .passthrough();

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
    /** The accounts this one says it is also: a list, or a single URI. */
    alsoKnownAs: z.union([z.string(), z.array(z.string())]).optional(),
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

/** A `Note`, or a `Question` (a note with poll options). */
export const NoteDocumentSchema = z
  .object({
    id: z.string().min(1),
    type: z.union([z.literal("Note"), z.literal("Question")]),
    oneOf: z.array(PollOptionDocumentSchema).optional(),
    anyOf: z.array(PollOptionDocumentSchema).optional(),
    endTime: z.string().nullable().optional(),
    closed: z.union([z.string(), z.boolean()]).nullable().optional(),
    votersCount: z.number().int().nonnegative().nullable().optional(),
    attributedTo: z.string().min(1),
    content: z.string(),
    /** The content per language; Mastodon sends one entry, keyed by the post's language. */
    contentMap: z.record(z.string(), z.unknown()).optional(),
    published: z.string().min(1),
    updated: z.string().nullable().optional(),
    url: z.string().optional(),
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
        }),
      )
      .optional(),
  })
  .passthrough();

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
  NestedActivityObjectSchema,
  ActorPublicKeySchema,
  ActorDocumentSchema,
  NoteDocumentSchema,
  PollVoteDocumentSchema,
]);
