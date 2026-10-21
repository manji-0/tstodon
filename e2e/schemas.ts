import { schemaResult } from "@tstodon/core";
import type { Activity as DomainActivity } from "@tstodon/domain";
import { z } from "zod";

/** DB / domain activity kinds (domain `Activity` uses `kind`; AS2 wire uses `type`). */
const DomainActivityKindSchema = z.enum([
  "Create",
  "Update",
  "Delete",
  "Follow",
  "Undo",
  "Accept",
  "Reject",
  "Like",
  "Announce",
] as const satisfies ReadonlyArray<DomainActivity["kind"]>);

/** Mastodon API account (verify_credentials / thin asserts). */
const MastodonAccountSchema = z
  .object({
    username: z.string().min(1),
  })
  .passthrough();

export type MastodonAccount = z.infer<typeof MastodonAccountSchema>;

export const MastodonAccount = {
  schema: MastodonAccountSchema,
  parse: schemaResult(MastodonAccountSchema),
} as const;

/** Mastodon API status (create + count asserts). */
const MastodonStatusSchema = z
  .object({
    id: z.string().min(1),
    favourites_count: z.number().optional(),
    reblogs_count: z.number().optional(),
  })
  .passthrough();

export type MastodonStatus = z.infer<typeof MastodonStatusSchema>;

export const MastodonStatus = {
  schema: MastodonStatusSchema,
  parse: schemaResult(MastodonStatusSchema),
} as const;

const WebFingerLinkSchema = z
  .object({
    rel: z.string().min(1),
    href: z.string().min(1).optional(),
  })
  .passthrough();

const WebFingerSchema = z
  .object({
    links: z.array(WebFingerLinkSchema).min(1),
  })
  .passthrough();

export type WebFinger = z.infer<typeof WebFingerSchema>;

export const WebFinger = {
  schema: WebFingerSchema,
  parse: schemaResult(WebFingerSchema),
  selfHref: (doc: WebFinger): string | undefined =>
    doc.links.find((l) => l.rel === "self" && typeof l.href === "string")?.href,
} as const;

/**
 * ActivityStreams Person on the wire. Discriminator is AS2 `type` (protocol),
 * not domain `kind` — domain RemoteActor uses a different shape.
 */
const ApPersonSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("Person"),
    preferredUsername: z.string().min(1),
    inbox: z.string().min(1),
    publicKey: z
      .object({
        id: z.string().min(1),
        publicKeyPem: z.string().min(1),
      })
      .passthrough(),
    name: z.string().optional(),
    endpoints: z
      .object({
        sharedInbox: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ApPerson = z.infer<typeof ApPersonSchema>;

export const ApPerson = {
  schema: ApPersonSchema,
  parse: schemaResult(ApPersonSchema),
} as const;

/** Nested Follow object as embedded in Undo / Accept on the wire. */
const ApFollowObjectSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("Follow"),
    actor: z.string().min(1).optional(),
    object: z.string().min(1).optional(),
  })
  .passthrough();

const ApLikeObjectSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("Like"),
    object: z.string().min(1).optional(),
  })
  .passthrough();

/**
 * Wire ActivityPub activities. AS2 uses `type`; domain `Activity` uses `kind`
 * and string `object`, so we keep a thin wire companion for e2e asserts.
 */
const ApFollowSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("Follow"),
    actor: z.string().min(1),
    object: z.string().min(1),
  })
  .passthrough();

const ApAcceptSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("Accept"),
    actor: z.string().min(1).optional(),
    object: z.union([z.string().min(1), ApFollowObjectSchema]),
  })
  .passthrough();

const ApCreateSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("Create"),
    actor: z.string().min(1).optional(),
    object: z.unknown(),
  })
  .passthrough();

const ApDeleteSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("Delete"),
    actor: z.string().min(1),
    object: z.string().min(1),
  })
  .passthrough();

const ApLikeSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("Like"),
    actor: z.string().min(1),
    object: z.string().min(1),
  })
  .passthrough();

const ApAnnounceSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("Announce"),
    actor: z.string().min(1),
    object: z.string().min(1),
  })
  .passthrough();

const ApUndoFollowSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("Undo"),
    actor: z.string().min(1),
    object: ApFollowObjectSchema,
  })
  .passthrough();

const ApUndoLikeSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("Undo"),
    actor: z.string().min(1),
    object: ApLikeObjectSchema,
  })
  .passthrough();

/** Undo is nested by object shape; keep Follow/Like undos as separate parse targets. */
export const ApWireActivitySchema = z.discriminatedUnion("type", [
  ApFollowSchema,
  ApAcceptSchema,
  ApCreateSchema,
  ApDeleteSchema,
  ApLikeSchema,
  ApAnnounceSchema,
  ApUndoFollowSchema,
]);

export type ApWireActivity = z.infer<typeof ApWireActivitySchema>;

export const ApWireActivity = {
  schema: ApWireActivitySchema,
  parse: schemaResult(ApWireActivitySchema),
  follow: { schema: ApFollowSchema, parse: schemaResult(ApFollowSchema) },
  accept: { schema: ApAcceptSchema, parse: schemaResult(ApAcceptSchema) },
  create: { schema: ApCreateSchema, parse: schemaResult(ApCreateSchema) },
  delete: { schema: ApDeleteSchema, parse: schemaResult(ApDeleteSchema) },
  like: { schema: ApLikeSchema, parse: schemaResult(ApLikeSchema) },
  announce: { schema: ApAnnounceSchema, parse: schemaResult(ApAnnounceSchema) },
  undoFollow: { schema: ApUndoFollowSchema, parse: schemaResult(ApUndoFollowSchema) },
  undoLike: { schema: ApUndoLikeSchema, parse: schemaResult(ApUndoLikeSchema) },
} as const;

export const acceptObjectId = (activity: z.infer<typeof ApAcceptSchema>): string | undefined => {
  const { object } = activity;
  if (typeof object === "string") {
    return object;
  }
  return object.id;
};

/** D1 `remote_follows` columns used by runners. */
const RemoteFollowRowSchema = z
  .object({
    remote_actor_uri: z.string().min(1).optional(),
    follow_kind: z.string().min(1).optional(),
  })
  .passthrough();

export type RemoteFollowRow = z.infer<typeof RemoteFollowRowSchema>;

export const RemoteFollowRow = {
  schema: RemoteFollowRowSchema,
  parse: schemaResult(RemoteFollowRowSchema),
  parseMany: schemaResult(z.array(RemoteFollowRowSchema)),
} as const;

/**
 * D1 `outbound_activities` — DB `kind` aligns with domain Activity kinds
 * (Create/Accept/…), while `payload_json` is AS2 wire JSON.
 */
const OutboundActivityRowSchema = z
  .object({
    id: z.string().min(1),
    kind: DomainActivityKindSchema.optional(),
    payload_json: z.string().min(1),
  })
  .passthrough();

export type OutboundActivityRow = z.infer<typeof OutboundActivityRowSchema>;

export const OutboundActivityRow = {
  schema: OutboundActivityRowSchema,
  parse: schemaResult(OutboundActivityRowSchema),
  parseMany: schemaResult(z.array(OutboundActivityRowSchema)),
} as const;

const OutboxDeliveryRowSchema = z
  .object({
    activity_id: z.string().min(1).optional(),
    inbox_url: z.string().min(1),
    kind: z.string().min(1).optional(),
  })
  .passthrough();

export type OutboxDeliveryRow = z.infer<typeof OutboxDeliveryRowSchema>;

export const OutboxDeliveryRow = {
  schema: OutboxDeliveryRowSchema,
  parse: schemaResult(OutboxDeliveryRowSchema),
  parseMany: schemaResult(z.array(OutboxDeliveryRowSchema)),
} as const;

const RemoteStatusRowSchema = z
  .object({
    id: z.string().min(1).optional(),
    object_uri: z.string().min(1).optional(),
    actor_uri: z.string().min(1).optional(),
    content_html: z.string().nullable().optional(),
  })
  .passthrough();

export type RemoteStatusRow = z.infer<typeof RemoteStatusRowSchema>;

export const RemoteStatusRow = {
  schema: RemoteStatusRowSchema,
  parse: schemaResult(RemoteStatusRowSchema),
  parseMany: schemaResult(z.array(RemoteStatusRowSchema)),
} as const;

const InboxActivityRowSchema = z
  .object({
    activity_id: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    payload_json: z.string().min(1).optional(),
  })
  .passthrough();

export type InboxActivityRow = z.infer<typeof InboxActivityRowSchema>;

export const InboxActivityRow = {
  schema: InboxActivityRowSchema,
  parse: schemaResult(InboxActivityRowSchema),
  parseMany: schemaResult(z.array(InboxActivityRowSchema)),
} as const;

const AccountPrivateKeyRowSchema = z
  .object({
    private_key_jwk: z.string().min(1),
  })
  .passthrough();

export type AccountPrivateKeyRow = z.infer<typeof AccountPrivateKeyRowSchema>;

export const AccountPrivateKeyRow = {
  schema: AccountPrivateKeyRowSchema,
  parse: schemaResult(AccountPrivateKeyRowSchema),
} as const;

const RemoteFavouriteRowSchema = z
  .object({
    remote_actor_uri: z.string().min(1).optional(),
    status_id: z.string().min(1).optional(),
  })
  .passthrough();

export const RemoteFavouriteRow = {
  schema: RemoteFavouriteRowSchema,
  parse: schemaResult(RemoteFavouriteRowSchema),
  parseMany: schemaResult(z.array(RemoteFavouriteRowSchema)),
} as const;

const RemoteAnnounceRowSchema = z
  .object({
    remote_actor_uri: z.string().min(1).optional(),
    status_id: z.string().min(1).optional(),
  })
  .passthrough();

export const RemoteAnnounceRow = {
  schema: RemoteAnnounceRowSchema,
  parse: schemaResult(RemoteAnnounceRowSchema),
  parseMany: schemaResult(z.array(RemoteAnnounceRowSchema)),
} as const;
