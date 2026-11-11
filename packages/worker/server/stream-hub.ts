import { DurableObject } from "cloudflare:workers";
import {
  StreamChannel,
  type StreamChannelValue,
  StreamDelivery,
  type StreamAccess,
  type StreamEventValue,
  type StreamRefusal,
} from "@tstodon/domain";
import {
  type ApiStreamingEventJSON,
  type ApiStreamingMessageJSON,
  encodeStreamingEvent,
} from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { RepositoryError } from "./d1";
import {
  parseSocketState,
  requestStreamChannel,
  type SocketState,
  streamRefusalError,
} from "./stream-access";
import {
  deleteSubscriptionRow,
  insertSubscriptionRow,
  subscriptionRow,
} from "./stream-subscription-store";
import { parseJsonText } from "./json-column";

/**
 * Streams one socket may hold. Mastodon's web UI multiplexes every column
 * over one socket, so this is the column count it allows; it also keeps the
 * attachment (at most 32 hashtags of the longest name) well under workerd's
 * 16 KiB attachment limit.
 */
export const MAX_SOCKET_CHANNELS = 32;

/**
 * Distinct hashtag and list streams one hub's sockets may hold together.
 * Each is a `stream_subscriptions` row and, for a hashtag, a timeline pass
 * when a status carries it; public streams (six at most) are not counted.
 */
export const MAX_HUB_TAGGED_CHANNELS = 32;

/** The header the streaming route hands a new socket's state to its hub in. */
export const SOCKET_STATE_HEADER = "x-tstodon-stream-socket";

/** The streaming contract's event for `event`, with its payload decoded. */
export const streamingEvent = (event: StreamEventValue): ApiStreamingEventJSON => {
  switch (event.kind) {
    case "delete":
      return { event: "delete", payload: event.statusId };
    case "notifications_merged":
      return { event: "notifications_merged", payload: "1" };
    case "update":
    case "status.update":
      return { event: event.kind, payload: event.payload };
    case "notification":
      return { event: "notification", payload: event.payload };
    case "conversation":
      return { event: "conversation", payload: event.payload };
  }
};

/**
 * Mastodon's streaming message for an event on one stream:
 * `{ stream, event, payload }`, with an object payload sent as a JSON string,
 * as the web UI and other clients expect.
 */
export const mastodonStreamMessage = (
  channel: StreamChannelValue,
  event: StreamEventValue,
): string => {
  const message: ApiStreamingMessageJSON = {
    stream: StreamChannel.streamName(channel),
    ...encodeStreamingEvent(streamingEvent(event)),
  };
  return JSON.stringify(message);
};

/**
 * Mastodon's SSE frame for an event: `event:` and `data:` lines, with the
 * payload as the WebSocket message carries it but without the `stream` tag,
 * since an SSE connection holds one stream.
 */
export const mastodonSseFrame = (event: StreamEventValue): string => {
  const wire = encodeStreamingEvent(streamingEvent(event));
  return `event: ${wire.event}\ndata: ${"payload" in wire ? wire.payload : ""}\n\n`;
};

/** Mastodon sends a `:thump` comment this often so proxies keep an idle connection open. */
export const SSE_HEARTBEAT_MS = 15_000;

/** Frames queued for a client that stopped reading before its connection is dropped. */
const MAX_SSE_BACKLOG = 256;

/**
 * Open SSE connections per hub. Unlike a hibernating WebSocket, an SSE
 * response keeps the Durable Object awake and billed, so it is bounded.
 */
export const MAX_EVENT_STREAMS = 32;

/** One open `text/event-stream` response: the stream it holds and how to write to it. */
type EventStreamConnection = Readonly<{
  state: SocketState;
  write: (text: string) => void;
  close: () => void;
}>;

/** A client's `subscribe` / `unsubscribe` message, as Mastodon's streaming server reads it. */
const StreamCommandSchema = z.object({
  type: z.union([z.literal("subscribe"), z.literal("unsubscribe")]),
  stream: z.string(),
  tag: z.string().optional(),
  list: z.union([z.string(), z.number()]).optional(),
});

const parseStreamCommand = schemaResult(StreamCommandSchema);

const parseJson = (text: string): unknown => parseJsonText(text).unwrapOr(undefined);

/**
 * One account's open streaming sockets. Each socket carries the streams it
 * subscribed to in its attachment, so they survive hibernation, and hears
 * only events for those streams.
 *
 * The hub mirrors its sockets' public, hashtag, and list subscriptions into
 * `stream_subscriptions`, one row per distinct channel, where fan-outs look
 * for whom to tell. A row is inserted before the first socket takes its
 * channel and deleted after the last one lets go, so the rows always cover
 * the live subscriptions; a row left behind (a hub evicted without close
 * events) is deleted the first time a fan-out finds nobody behind it.
 * Every change runs one at a time, in arrival order, so a socket's
 * `subscribe` then `unsubscribe` land in that order and a close during a
 * pending subscribe still cleans its row.
 */
export class StreamHub extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Open SSE responses. They live in memory, not in a socket attachment: a
   * response being streamed keeps the hub awake, so the hub is never
   * hibernated or evicted while one is open (unlike WebSockets, which it
   * hibernates when idle). A hub reset by a deploy drops them, and their
   * `stream_subscriptions` rows are removed by the next fan-out that finds
   * nobody behind them.
   */
  private readonly eventStreams = new Set<EventStreamConnection>();

  /** Deliver to this hub, which `publishToHub` names as `hub`. */
  async publish(hub: string, raw: unknown): Promise<void> {
    const delivery = StreamDelivery.parse(raw);
    if (delivery.isErr()) {
      return;
    }
    const wanted = new Set(delivery.value.channels.map(StreamChannel.key));
    const { event } = delivery.value;
    for (const { socket, state } of this.openSockets()) {
      for (const channel of state.channels) {
        if (wanted.has(StreamChannel.key(channel)) && mayHear(state.access, event)) {
          socket.send(mastodonStreamMessage(channel, event));
        }
      }
    }
    for (const connection of [...this.eventStreams]) {
      const { state } = connection;
      if (
        mayHear(state.access, event) &&
        state.channels.some((channel) => wanted.has(StreamChannel.key(channel)))
      ) {
        connection.write(mastodonSseFrame(event));
      }
    }
    await this.serially(async () => {
      const held = this.heldKeys();
      for (const channel of delivery.value.channels) {
        if (!held.has(StreamChannel.key(channel))) {
          await this.dropRow(hub, channel);
        }
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const state = parseSocketState(parseJson(request.headers.get(SOCKET_STATE_HEADER) ?? ""));
    if (state.isErr()) {
      return new Response("Missing socket state", { status: 400 });
    }
    const hub = state.value.accountId;
    if (request.headers.get("Upgrade") !== "websocket") {
      return this.serially(() => this.openEventStream(hub, state.value));
    }
    return this.serially(async () => {
      const refusal = this.admit([], state.value.channels);
      if (refusal) {
        const error = streamRefusalError(refusal);
        return Response.json(error, { status: error.status });
      }
      const pair = new WebSocketPair();
      if (!attach(pair[1], state.value)) {
        const error = streamRefusalError({ kind: "SocketFull" });
        return Response.json(error, { status: error.status });
      }
      const written = await this.addRows(hub, state.value.channels);
      if (written.isErr()) {
        const error = streamRefusalError({ kind: "Unavailable" });
        return Response.json(error, { status: error.status });
      }
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }

  /** An SSE response for `state`'s one stream, which `publish` writes to until the client goes. */
  private async openEventStream(hub: string, state: SocketState): Promise<Response> {
    if (this.eventStreams.size >= MAX_EVENT_STREAMS) {
      return Response.json({ error: "Too many streaming connections" }, { status: 429 });
    }
    const refusal = this.admit([], state.channels);
    if (refusal) {
      const error = streamRefusalError(refusal);
      return Response.json(error, { status: error.status });
    }
    const written = await this.addRows(hub, state.channels);
    if (written.isErr()) {
      const error = streamRefusalError({ kind: "Unavailable" });
      return Response.json(error, { status: error.status });
    }
    const encoder = new TextEncoder();
    let connection: EventStreamConnection | undefined;
    const release = (): void => {
      if (connection && this.eventStreams.delete(connection)) {
        const released = connection;
        this.ctx.waitUntil(
          this.serially(async () => {
            for (const channel of released.state.channels) {
              await this.dropRowIfUnheld(hub, channel);
            }
          }),
        );
      }
    };
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const heartbeat = setInterval(() => connection?.write(":thump\n\n"), SSE_HEARTBEAT_MS);
        const close = (): void => {
          clearInterval(heartbeat);
          release();
          try {
            controller.close();
          } catch {
            // The client already cancelled the stream.
          }
        };
        const write = (text: string): void => {
          if ((controller.desiredSize ?? 0) < -MAX_SSE_BACKLOG) {
            close();
            return;
          }
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            close();
          }
        };
        connection = { state, write, close };
        this.eventStreams.add(connection);
        write(":)\n\n");
      },
      cancel: () => {
        connection?.close();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  }

  /** `subscribe` / `unsubscribe` messages change which streams the socket hears. */
  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const command = parseStreamCommand(
      typeof message === "string" ? parseJson(message) : undefined,
    );
    if (command.isErr()) {
      socket.send(JSON.stringify({ error: "Invalid message", status: 400 }));
      return;
    }
    const wire = {
      stream: command.value.stream,
      tag: command.value.tag,
      list: command.value.list === undefined ? undefined : String(command.value.list),
    };
    const refused = await this.serially(() =>
      command.value.type === "subscribe"
        ? this.subscribe(socket, wire)
        : this.unsubscribe(socket, wire),
    );
    if (refused.isErr() && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(streamRefusalError(refused.error)));
    }
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.dropAfterClose(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.dropAfterClose(socket);
  }

  private async subscribe(
    socket: WebSocket,
    wire: Parameters<typeof StreamChannel.fromWire>[0],
  ): Promise<Result<void, StreamRefusal>> {
    const state = this.stateOf(socket);
    if (!state) {
      return ok(undefined);
    }
    const channel = await requestStreamChannel(this.env, state.accountId, state.access, wire);
    if (channel.isErr()) {
      return err(channel.error);
    }
    if (socket.readyState !== WebSocket.OPEN) {
      return ok(undefined);
    }
    const target = StreamChannel.key(channel.value);
    if (state.channels.some((held) => StreamChannel.key(held) === target)) {
      return ok(undefined);
    }
    const refusal = this.admit(state.channels, [channel.value]);
    if (refusal) {
      return err(refusal);
    }
    const hub = state.accountId;
    const written = await this.addRows(hub, [channel.value]);
    if (written.isErr()) {
      return err({ kind: "Unavailable" });
    }
    // The socket may have closed while the row was written; its close
    // handler did not know about this channel, so let go of it here.
    if (socket.readyState !== WebSocket.OPEN) {
      await this.dropRowIfUnheld(hub, channel.value);
      return ok(undefined);
    }
    if (!attach(socket, { ...state, channels: [...state.channels, channel.value] })) {
      await this.dropRowIfUnheld(hub, channel.value);
      return err({ kind: "SocketFull" });
    }
    return ok(undefined);
  }

  private async unsubscribe(
    socket: WebSocket,
    wire: Parameters<typeof StreamChannel.fromWire>[0],
  ): Promise<Result<void, StreamRefusal>> {
    const channel = StreamChannel.fromWire(wire);
    if (channel.isErr()) {
      return err(channel.error);
    }
    const state = this.stateOf(socket);
    if (!state) {
      return ok(undefined);
    }
    const target = StreamChannel.key(channel.value);
    if (!state.channels.some((held) => StreamChannel.key(held) === target)) {
      return ok(undefined);
    }
    attach(socket, {
      ...state,
      channels: state.channels.filter((held) => StreamChannel.key(held) !== target),
    });
    await this.dropRowIfUnheld(state.accountId, channel.value);
    return ok(undefined);
  }

  /** A closed socket's attachment goes with it, so read its channels before waiting. */
  private async dropAfterClose(socket: WebSocket): Promise<void> {
    const state = this.stateOf(socket);
    if (!state) {
      return;
    }
    await this.serially(async () => {
      for (const channel of state.channels) {
        await this.dropRowIfUnheld(state.accountId, channel);
      }
    });
  }

  /** Why `adding` may not join a socket already holding `holding`, if it may not. */
  private admit(
    holding: ReadonlyArray<StreamChannelValue>,
    adding: ReadonlyArray<StreamChannelValue>,
  ): StreamRefusal | undefined {
    if (holding.length + adding.length > MAX_SOCKET_CHANNELS) {
      return { kind: "SocketFull" };
    }
    const tagged = new Set(
      [...this.heldChannels(), ...adding].filter(isTagged).map(StreamChannel.key),
    );
    return tagged.size > MAX_HUB_TAGGED_CHANNELS ? { kind: "HubFull" } : undefined;
  }

  /** Insert the rows of `channels` no open socket holds yet. */
  private async addRows(
    hub: string,
    channels: ReadonlyArray<StreamChannelValue>,
  ): Promise<Result<void, RepositoryError>> {
    const held = this.heldKeys();
    for (const channel of channels) {
      const row = subscriptionRow(channel);
      if (row && !held.has(StreamChannel.key(channel))) {
        const written = await insertSubscriptionRow(this.env.DB, hub, row);
        if (written.isErr()) {
          return written;
        }
      }
    }
    return ok(undefined);
  }

  private async dropRowIfUnheld(hub: string, channel: StreamChannelValue): Promise<void> {
    if (!this.heldKeys().has(StreamChannel.key(channel))) {
      await this.dropRow(hub, channel);
    }
  }

  /** Best effort: a row that stays is dropped by the next fan-out that finds nobody behind it. */
  private async dropRow(hub: string, channel: StreamChannelValue): Promise<void> {
    const row = subscriptionRow(channel);
    if (row) {
      await deleteSubscriptionRow(this.env.DB, hub, row);
    }
  }

  /** Run `work` after every change queued before it. */
  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private heldKeys(): Set<string> {
    return new Set(this.heldChannels().map(StreamChannel.key));
  }

  /** Every channel a WebSocket or an SSE response holds. */
  private heldChannels(): StreamChannelValue[] {
    return [
      ...this.openSockets().flatMap(({ state }) => state.channels),
      ...[...this.eventStreams].flatMap((connection) => connection.state.channels),
    ];
  }

  /**
   * The open sockets with their state. A socket whose attachment no longer
   * parses (one a deploy left with an older shape, such as a tokenless
   * socket from before streaming needed a token) is closed, not served.
   */
  private openSockets(): Array<Readonly<{ socket: WebSocket; state: SocketState }>> {
    return this.ctx
      .getWebSockets()
      .filter((socket) => socket.readyState === WebSocket.OPEN)
      .flatMap((socket) => {
        const state = this.stateOf(socket);
        return state ? [{ socket, state }] : [];
      });
  }

  /** The socket's state, or undefined after closing a socket whose attachment does not parse. */
  private stateOf(socket: WebSocket): SocketState | undefined {
    const state = parseSocketState(socket.deserializeAttachment());
    if (state.isOk()) {
      return state.value;
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1008, "Missing access token");
    }
    return undefined;
  }
}

/** A token without `read:notifications` hears no notifications on `user`. */
const mayHear = (access: StreamAccess, event: StreamEventValue): boolean =>
  access.notifications || (event.kind !== "notification" && event.kind !== "notifications_merged");

const isTagged = (channel: StreamChannelValue): boolean =>
  channel.kind === "Hashtag" || channel.kind === "List";

/** Store `state` on the socket; false when it is over workerd's attachment limit. */
const attach = (socket: WebSocket, state: SocketState): boolean => {
  try {
    socket.serializeAttachment(state);
    return true;
  } catch {
    return false;
  }
};
