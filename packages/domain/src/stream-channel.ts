import { schemaResult, unitKind } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { StreamEvent } from "./stream-event";

/** Which statuses a public stream carries: all, this instance's, or other instances'. */
const PublicOriginSchema = z.union([z.literal("All"), z.literal("Local"), z.literal("Remote")]);

const PublicChannelSchema = z.object({
  kind: z.literal("Public"),
  origin: PublicOriginSchema,
  onlyMedia: z.boolean(),
});

/** The longest hashtag (in UTF-16 units) a stream may name, as Mastodon caps tag names. */
export const STREAM_TAG_MAX_LENGTH = 100;

/** The longest list id a stream may name; entity ids are far shorter. */
export const STREAM_LIST_ID_MAX_LENGTH = 64;

/**
 * Mastodon's hashtag name: letters, digits, and underscores, with at least
 * one letter. Nothing else (no `%`, spaces, or punctuation) reaches a query.
 */
const HASHTAG_NAME = /^[\p{L}\p{M}\p{N}_]*\p{L}[\p{L}\p{M}\p{N}_]*$/u;

const HashtagChannelSchema = z.object({
  kind: z.literal("Hashtag"),
  /** As the client spelled it; Mastodon echoes it back in `stream`. */
  tag: z.string().max(STREAM_TAG_MAX_LENGTH).regex(HASHTAG_NAME),
  localOnly: z.boolean(),
});

const ListChannelSchema = z.object({
  kind: z.literal("List"),
  listId: z.string().min(1).max(STREAM_LIST_ID_MAX_LENGTH),
});

/**
 * One stream a streaming socket can subscribe to, as Mastodon's streaming
 * API names them: `user`, `user:notification`, `direct`,
 * `public[:local|:remote][:media]`, `hashtag[:local]` with a `tag`, and
 * `list` with a `list` id.
 */
export const StreamChannelSchema = z.discriminatedUnion("kind", [
  unitKind("User"),
  unitKind("UserNotification"),
  unitKind("Direct"),
  PublicChannelSchema,
  HashtagChannelSchema,
  ListChannelSchema,
]);

export type StreamChannel = z.infer<typeof StreamChannelSchema>;

type PublicChannel = z.infer<typeof PublicChannelSchema>;

const PUBLIC_STREAMS = {
  public: { origin: "All", onlyMedia: false },
  "public:media": { origin: "All", onlyMedia: true },
  "public:local": { origin: "Local", onlyMedia: false },
  "public:local:media": { origin: "Local", onlyMedia: true },
  "public:remote": { origin: "Remote", onlyMedia: false },
  "public:remote:media": { origin: "Remote", onlyMedia: true },
} as const satisfies Record<string, Omit<PublicChannel, "kind">>;

const publicStreamName = (channel: PublicChannel): string => {
  const origin = channel.origin === "All" ? "" : `:${channel.origin.toLowerCase()}`;
  return `public${origin}${channel.onlyMedia ? ":media" : ""}`;
};

const isPublicStream = (stream: string): stream is keyof typeof PUBLIC_STREAMS =>
  Object.hasOwn(PUBLIC_STREAMS, stream);

/** Why a requested stream is not one Mastodon's streaming API serves. */
export type StreamChannelError =
  | Readonly<{ kind: "UnknownStream" }>
  | Readonly<{ kind: "MissingTag" }>
  | Readonly<{ kind: "InvalidTag" }>
  | Readonly<{ kind: "MissingList" }>
  | Readonly<{ kind: "InvalidList" }>;

/**
 * The `stream` array Mastodon tags an event with: the stream name, then the
 * tag or list id for `hashtag*` and `list`. Clients route events by it.
 */
const streamName = (channel: StreamChannel): string[] => {
  switch (channel.kind) {
    case "User":
      return ["user"];
    case "UserNotification":
      return ["user:notification"];
    case "Direct":
      return ["direct"];
    case "Public":
      return [publicStreamName(channel)];
    case "Hashtag":
      return [channel.localOnly ? "hashtag:local" : "hashtag", channel.tag];
    case "List":
      return ["list", channel.listId];
  }
};

/** Identity of a channel: hashtags compare case-insensitively, as Mastodon normalizes them. */
const key = (channel: StreamChannel): string =>
  JSON.stringify(
    channel.kind === "Hashtag"
      ? streamName({ ...channel, tag: channel.tag.toLowerCase() })
      : streamName(channel),
  );

/** Parse a stream as a client names it, in the query string or a `subscribe` message. */
const fromWire = (
  input: Readonly<{ stream: string; tag?: string | undefined; list?: string | undefined }>,
): Result<StreamChannel, StreamChannelError> => {
  const tag = (input.tag ?? "").trim().replace(/^#/, "");
  const list = (input.list ?? "").trim();
  switch (input.stream) {
    case "user":
      return ok({ kind: "User" });
    case "user:notification":
      return ok({ kind: "UserNotification" });
    case "direct":
      return ok({ kind: "Direct" });
    case "hashtag":
    case "hashtag:local": {
      if (tag.length === 0) {
        return err({ kind: "MissingTag" });
      }
      const channel = HashtagChannelSchema.safeParse({
        kind: "Hashtag",
        tag,
        localOnly: input.stream === "hashtag:local",
      });
      return channel.success ? ok(channel.data) : err({ kind: "InvalidTag" });
    }
    case "list": {
      if (list.length === 0) {
        return err({ kind: "MissingList" });
      }
      const channel = ListChannelSchema.safeParse({ kind: "List", listId: list });
      return channel.success ? ok(channel.data) : err({ kind: "InvalidList" });
    }
    default:
      return isPublicStream(input.stream)
        ? ok({ kind: "Public", ...PUBLIC_STREAMS[input.stream] })
        : err({ kind: "UnknownStream" });
  }
};

export const StreamChannel = {
  schema: StreamChannelSchema,
  parse: schemaResult(StreamChannelSchema),
  fromWire,
  streamName,
  key,
} as const;

/** An event for the sockets subscribed to any of `channels`. */
export const StreamDeliverySchema = z.object({
  channels: z.array(StreamChannelSchema),
  event: StreamEvent.schema,
});

export type StreamDelivery = z.infer<typeof StreamDeliverySchema>;

export const StreamDelivery = {
  schema: StreamDeliverySchema,
  parse: schemaResult(StreamDeliverySchema),
} as const;
