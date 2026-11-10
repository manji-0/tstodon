import { z } from "zod";
import { ApiAnnouncement } from "./announcement";
import { ApiConversation } from "./conversation";
import { ApiNotification } from "./notification";
import { ApiStatus } from "./status";
import { isJsonStreamingEventName, STREAMING_EVENTS } from "./values";

/**
 * Mastodon's streaming API (`/api/v1/streaming`): each event has a name
 * (`event`) and a payload. A WebSocket message is `{ stream, event, payload }`
 * and an SSE frame `event: <event>` / `data: <payload>`; either way an entity
 * payload travels as a JSON string inside the message, and an id as a plain
 * string. `event` is the discriminator, as Mastodon's own field.
 *
 * `ApiStreamingEvent` is an event with its payload decoded (the entity); the
 * `*Wire*` types are the same events with the payload as sent.
 */

/** `announcement.reaction`: an announcement reaction's new count, for everyone. */
export const ApiAnnouncementReactionEvent = z.object({
  name: z.string(),
  count: z.number(),
  announcement_id: z.string(),
});
export type ApiAnnouncementReactionEventJSON = z.infer<typeof ApiAnnouncementReactionEvent>;

/** An event with its payload decoded. */
export const ApiStreamingEvent = z.discriminatedUnion("event", [
  /** A status entered the stream's timeline. */
  z.object({ event: z.literal("update"), payload: ApiStatus }),
  /** A status in the timeline was edited (or its poll closed). */
  z.object({ event: z.literal("status.update"), payload: ApiStatus }),
  /** A status was deleted: its id. */
  z.object({ event: z.literal("delete"), payload: z.string() }),
  /** A v1 notification, on `user` and `user:notification`. */
  z.object({ event: z.literal("notification"), payload: ApiNotification }),
  /** Accepted notification requests were merged into the notifications; Mastodon sends `"1"`. */
  z.object({ event: z.literal("notifications_merged"), payload: z.literal("1") }),
  /** A conversation on `direct` changed. */
  z.object({ event: z.literal("conversation"), payload: ApiConversation }),
  /** Mastodon only: an announcement was published or changed. */
  z.object({ event: z.literal("announcement"), payload: ApiAnnouncement }),
  /** Mastodon only. */
  z.object({ event: z.literal("announcement.reaction"), payload: ApiAnnouncementReactionEvent }),
  /** Mastodon only: an announcement was withdrawn, its id. */
  z.object({ event: z.literal("announcement.delete"), payload: z.string() }),
  /** Mastodon only: the viewer's filters changed; no payload. */
  z.object({ event: z.literal("filters_changed") }),
]);
export type ApiStreamingEventJSON = z.infer<typeof ApiStreamingEvent>;
export type ApiStreamingEventName = ApiStreamingEventJSON["event"];

/** The decoded payload of event `E`. */
export type ApiStreamingPayloadJSON<E extends ApiStreamingEventName> = Extract<
  ApiStreamingEventJSON,
  { event: E; payload: unknown }
>["payload"];

/** An event as sent: a string payload stays as it is, an entity is a JSON string. */
type Wire<T> = T extends { event: infer E; payload: infer P }
  ? { event: E; payload: P extends string ? P : string }
  : T;
export type ApiStreamingWireEventJSON = Wire<ApiStreamingEventJSON>;

/**
 * The stream a WebSocket message belongs to: `["user"]`, `["public:local"]`,
 * `["hashtag", "cats"]`, `["list", "12"]`, ...
 */
export const ApiStreamName = z.array(z.string()).min(1).max(2);
export type ApiStreamNameJSON = z.infer<typeof ApiStreamName>;

/** A WebSocket message as sent. */
export type ApiStreamingMessageJSON = ApiStreamingWireEventJSON & { stream: ApiStreamNameJSON };

/** `event` with its payload encoded as Mastodon's streaming server sends it. */
export const encodeStreamingEvent = (event: ApiStreamingEventJSON): ApiStreamingWireEventJSON => {
  switch (event.event) {
    case "delete":
    case "notifications_merged":
    case "announcement.delete":
    case "filters_changed":
      return event;
    case "update":
    case "status.update":
    case "notification":
    case "conversation":
    case "announcement":
    case "announcement.reaction":
      return { event: event.event, payload: JSON.stringify(event.payload) };
  }
};

/** A wire payload decoded: the JSON of an entity event parsed, any other left as sent. */
const decodedWire = (
  wire: Readonly<{ event: string; payload?: string | undefined }>,
  context: z.RefinementCtx,
): unknown => {
  if (wire.payload === undefined || !isJsonStreamingEventName(wire.event)) {
    return wire;
  }
  try {
    const payload: unknown = JSON.parse(wire.payload);
    return { event: wire.event, payload };
  } catch {
    context.addIssue({ code: "custom", message: "payload is not JSON", path: ["payload"] });
    return z.NEVER;
  }
};

const WireShape = z.object({
  event: z.literal(STREAMING_EVENTS),
  payload: z.string().optional(),
});

/**
 * An event as an SSE frame carries it (`event` and the `data` line as
 * `payload`), parsed to its decoded form. For tests and clients that check
 * what they receive; the server does not parse its own events.
 */
export const ApiStreamingWireEvent = WireShape.transform(decodedWire).pipe(ApiStreamingEvent);

/** A WebSocket message as sent, parsed to `{ stream, event, payload }` with the payload decoded. */
export const ApiStreamingMessage = WireShape.extend({ stream: ApiStreamName })
  .transform((message, context) => {
    const decoded = decodedWire(message, context);
    return typeof decoded === "object" && decoded !== null
      ? { ...decoded, stream: message.stream }
      : decoded;
  })
  .pipe(z.intersection(z.object({ stream: ApiStreamName }), ApiStreamingEvent));
export type ApiStreamingDecodedMessageJSON = z.output<typeof ApiStreamingMessage>;
