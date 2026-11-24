import { schemaResult } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import { IsoInstant } from "./iso-instant";
import { RemotePoll, RemotePollSchema } from "./remote-poll";
import { QuoteInteractionPolicy, QuoteInteractionPolicySchema } from "./quote-approval-policy";
import { StatusId } from "./status-id";
import { RemoteVisibility, Visibility } from "./visibility";
import type { StatusLanguage } from "./status-quote-target";

/**
 * A remote note's attachment. The blurhash, the size and the focus point are
 * what the note declares; each is absent when the note has none that reads.
 */
export const RemoteAttachmentSchema = z.object({
  url: z.url(),
  /** Empty when the remote note did not declare a media type. */
  mediaType: z.string(),
  description: z.string(),
  blurhash: z.string().min(1).optional(),
  /** The original file's size in pixels. */
  size: z.object({ width: z.int().positive(), height: z.int().positive() }).optional(),
  /** The focal point, each axis from -1 to 1. */
  focus: z.object({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1) }).optional(),
  /** The thumbnail the note names in the attachment's `icon` (a video's poster, an audio's cover). */
  thumbnailUrl: z.url().optional(),
});

export type RemoteAttachment = z.infer<typeof RemoteAttachmentSchema>;

/** A custom emoji a remote note or actor declares in its `tag`. */
export const RemoteEmojiSchema = z.object({
  /** The name between the colons, without them. */
  shortcode: z.string().min(1),
  url: z.url(),
  /** The tag's `updated`: when the emoji last changed on its server. */
  updated: IsoInstant.schema.optional(),
});

export type RemoteEmoji = z.infer<typeof RemoteEmojiSchema>;

const RemoteNoteSchema = z.object({
  kind: z.literal("RemoteNote"),
  id: StatusId.schema,
  actorUri: z.url(),
  objectUri: z.url(),
  url: z.url().optional(),
  contentHtml: z.string(),
  spoilerText: z.string(),
  visibility: RemoteVisibility.schema,
  sensitive: z.boolean(),
  language: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("None") }),
    z.object({ kind: z.literal("Present"), value: z.string().min(1) }),
  ]),
  publishedAt: IsoInstant.schema,
  /**
   * When the author last edited the note: from the `Update` that carried the
   * edit, or the `updated` of the document it was first stored from.
   */
  editedAt: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("Never") }),
    z.object({ kind: z.literal("Edited"), at: IsoInstant.schema }),
  ]),
  media: z.array(RemoteAttachmentSchema),
  poll: RemotePollSchema,
  /** Who the author lets quote the note, from its `interactionPolicy.canQuote`. */
  quotePolicy: QuoteInteractionPolicySchema,
});

export const RemoteStatusSchema = z.discriminatedUnion("kind", [RemoteNoteSchema]);

export type RemoteNote = z.infer<typeof RemoteNoteSchema>;
export type RemoteStatus = z.infer<typeof RemoteStatusSchema>;

export type RemoteStatusParseError = Readonly<{ kind: "InvalidObject" }>;

const PUBLIC_AUDIENCE = new Set([
  "https://www.w3.org/ns/activitystreams#Public",
  "as:Public",
  "Public",
]);

const parseRemoteStatus = schemaResult(RemoteStatusSchema);

const audienceHasFollowers = (uris: ReadonlyArray<string>): boolean => {
  for (const uri of uris) {
    if (uri.endsWith("/followers")) {
      return true;
    }
  }
  return false;
};

const audienceHasPublic = (uris: ReadonlyArray<string>): boolean => {
  for (const uri of uris) {
    if (PUBLIC_AUDIENCE.has(uri)) {
      return true;
    }
  }
  return false;
};

export const RemoteStatus = {
  schema: RemoteStatusSchema,
  parse: parseRemoteStatus,
  visibilityFromAudience: (
    to: ReadonlyArray<string>,
    cc: ReadonlyArray<string>,
  ): z.infer<typeof Visibility.schema> => {
    if (audienceHasPublic(to)) {
      return Visibility.Public;
    }
    if (audienceHasPublic(cc)) {
      return Visibility.Unlisted;
    }
    if (audienceHasFollowers(to) || audienceHasFollowers(cc)) {
      return Visibility.FollowersOnly;
    }
    return Visibility.Direct;
  },
  fromFetched: (input: {
    id: z.infer<typeof StatusId.schema>;
    media?: ReadonlyArray<RemoteAttachment> | undefined;
    actorUri: string;
    objectUri: string;
    url?: string | undefined;
    contentHtml: string;
    spoilerText: string;
    visibility: RemoteVisibility;
    sensitive: boolean;
    language: StatusLanguage;
    publishedAt: z.infer<typeof IsoInstant.schema>;
    editedAt?: z.infer<typeof IsoInstant.schema> | undefined;
    poll?: RemotePoll | undefined;
    quotePolicy?: QuoteInteractionPolicy | undefined;
  }): Result<RemoteStatus, RemoteStatusParseError> => {
    const parsed = parseRemoteStatus({
      kind: "RemoteNote",
      id: input.id,
      actorUri: input.actorUri,
      objectUri: input.objectUri,
      contentHtml: input.contentHtml,
      spoilerText: input.spoilerText,
      visibility: input.visibility,
      sensitive: input.sensitive,
      language: input.language,
      publishedAt: input.publishedAt,
      editedAt: input.editedAt ? { kind: "Edited", at: input.editedAt } : { kind: "Never" },
      // Mastodon carries at most four attachments on a status.
      media: (input.media ?? []).slice(0, 4),
      poll: input.poll ?? RemotePoll.none,
      quotePolicy: input.quotePolicy ?? QuoteInteractionPolicy.none,
      ...(input.url ? { url: input.url } : {}),
    });
    return parsed.mapErr((): RemoteStatusParseError => ({ kind: "InvalidObject" }));
  },
} as const;
