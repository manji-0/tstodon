import { warmSchemas } from "@tstodon/core";
import { z } from "zod";
import { booleanish } from "./form-values";

export const JsonObjectSchema = z.record(z.string(), z.unknown());

export const ActivityJsonSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    actor: z.string().min(1),
    object: z.union([z.string().min(1), z.object({ id: z.string().min(1) }).passthrough()]),
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
    publicKey: ActorPublicKeySchema,
    name: z.string().optional(),
    endpoints: z
      .object({
        sharedInbox: z.string().min(1).optional(),
      })
      .optional(),
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

export const NoteDocumentSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("Note"),
    attributedTo: z.string().min(1),
    content: z.string(),
    published: z.string().min(1),
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

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([
  JsonObjectSchema,
  ActivityJsonSchema,
  NestedActivityObjectSchema,
  ActorPublicKeySchema,
  ActorDocumentSchema,
  NoteDocumentSchema,
]);
