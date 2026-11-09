import { z } from "zod";
import { ApUri, withContext } from "./context";

/** An avatar, header or emoji image. */
export const ApImage = z.object({
  type: z.literal("Image"),
  mediaType: z.string().optional(),
  url: ApUri,
});
export type ApImageJSON = z.infer<typeof ApImage>;

/** A custom emoji its name, bio or fields use (`toot:Emoji`). */
export const ApEmoji = z.object({
  type: z.literal("Emoji"),
  name: z.string().regex(/^:[^:\s]+:$/),
  icon: ApImage,
});
export type ApEmojiJSON = z.infer<typeof ApEmoji>;

/** A profile field (`schema:PropertyValue`): `value` is HTML. */
export const ApPropertyValue = z.object({
  type: z.literal("PropertyValue"),
  name: z.string(),
  value: z.string(),
});
export type ApPropertyValueJSON = z.infer<typeof ApPropertyValue>;

/** An actor's key for HTTP signatures. */
export const ApPublicKey = z.object({
  id: ApUri,
  owner: ApUri,
  publicKeyPem: z.string().startsWith("-----BEGIN PUBLIC KEY-----"),
});
export type ApPublicKeyJSON = z.infer<typeof ApPublicKey>;

/**
 * A local account's actor, as Mastodon's `ActivityPub::ActorSerializer`:
 * a `Person`, or a `Service` for a bot. A suspended account shows none of its
 * profile and says `suspended`. `alsoKnownAs` / `movedTo` only when there is
 * one. This is the object an actor `Update` carries; the document served at
 * the actor's URI is {@link ApActorDocument}.
 */
export const ApActor = z.object({
  id: ApUri,
  type: z.literal(["Person", "Service"]),
  preferredUsername: z.string().min(1),
  name: z.string(),
  summary: z.string(),
  inbox: ApUri,
  outbox: ApUri,
  followers: ApUri,
  following: ApUri,
  endpoints: z.object({ sharedInbox: ApUri }),
  url: ApUri,
  manuallyApprovesFollowers: z.boolean(),
  discoverable: z.boolean(),
  indexable: z.boolean(),
  /** The day the account joined, as Mastodon publishes it. */
  published: z.iso.datetime(),
  suspended: z.literal(true).optional(),
  publicKey: ApPublicKey,
  tag: z.array(ApEmoji),
  attachment: z.array(ApPropertyValue),
  icon: ApImage.optional(),
  image: ApImage.optional(),
  alsoKnownAs: z.array(ApUri).optional(),
  movedTo: ApUri.optional(),
});
export type ApActorJSON = z.infer<typeof ApActor>;

export const ApActorDocument = withContext(ApActor);
export type ApActorDocumentJSON = z.infer<typeof ApActorDocument>;

/** The instance actor (`GET /actor`), as Mastodon's `InstanceActorSerializer`. */
export const ApInstanceActorDocument = withContext(
  z.object({
    id: ApUri,
    type: z.literal("Application"),
    preferredUsername: z.string().min(1),
    inbox: ApUri,
    endpoints: z.object({ sharedInbox: ApUri }),
    url: ApUri,
    manuallyApprovesFollowers: z.literal(true),
    publicKey: ApPublicKey,
  }),
);
export type ApInstanceActorDocumentJSON = z.infer<typeof ApInstanceActorDocument>;
