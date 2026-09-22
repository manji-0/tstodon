import { schemaResult } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import { IsoInstant } from "./iso-instant";
import { StatusId } from "./status-id";
import { Visibility } from "./visibility";
import type { StatusLanguage } from "./status-quote-target";

const RemoteNoteSchema = z.object({
  kind: z.literal("RemoteNote"),
  id: StatusId.schema,
  actorUri: z.url(),
  objectUri: z.url(),
  url: z.url().optional(),
  contentHtml: z.string(),
  spoilerText: z.string(),
  visibility: Visibility.schema,
  sensitive: z.boolean(),
  language: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("None") }),
    z.object({ kind: z.literal("Present"), value: z.string().min(1) }),
  ]),
  publishedAt: IsoInstant.schema,
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

export const RemoteStatus = {
  schema: RemoteStatusSchema,
  parse: schemaResult(RemoteStatusSchema),
  visibilityFromAudience: (
    to: ReadonlyArray<string>,
    cc: ReadonlyArray<string>,
  ): z.infer<typeof Visibility.schema> => {
    const addressed = [...to, ...cc];
    if (to.some((uri) => PUBLIC_AUDIENCE.has(uri))) {
      return Visibility.Public;
    }
    if (cc.some((uri) => PUBLIC_AUDIENCE.has(uri))) {
      return Visibility.Unlisted;
    }
    if (addressed.some((uri) => uri.endsWith("/followers"))) {
      return Visibility.FollowersOnly;
    }
    return Visibility.Direct;
  },
  fromFetched: (input: {
    id: z.infer<typeof StatusId.schema>;
    actorUri: string;
    objectUri: string;
    url?: string | undefined;
    contentHtml: string;
    spoilerText: string;
    visibility: z.infer<typeof Visibility.schema>;
    sensitive: boolean;
    language: StatusLanguage;
    publishedAt: z.infer<typeof IsoInstant.schema>;
  }): Result<RemoteStatus, RemoteStatusParseError> => {
    const parsed = schemaResult(RemoteStatusSchema)({
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
      ...(input.url ? { url: input.url } : {}),
    });
    return parsed.mapErr((): RemoteStatusParseError => ({ kind: "InvalidObject" }));
  },
} as const;
