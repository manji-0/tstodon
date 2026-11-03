import { DurableObject } from "cloudflare:workers";
import {
  StreamChannel,
  type StreamChannelValue,
  StreamDelivery,
  type StreamEventValue,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import {
  parseSocketState,
  requestStreamChannel,
  type SocketState,
  type StreamRefusal,
  streamRefusalError,
} from "./stream-access";

/** The header the streaming route hands a new socket's state to its hub in. */
export const SOCKET_STATE_HEADER = "x-tstodon-stream-socket";

/**
 * Mastodon's streaming message for an event on one stream:
 * `{ stream, event, payload }`, with an object payload sent as a JSON string,
 * as the web UI and other clients expect.
 */
export const mastodonStreamMessage = (
  channel: StreamChannelValue,
  event: StreamEventValue,
): string => {
  const stream = StreamChannel.streamName(channel);
  switch (event.kind) {
    case "delete":
      return JSON.stringify({ stream, event: "delete", payload: event.statusId });
    case "notifications_merged":
      return JSON.stringify({ stream, event: "notifications_merged", payload: "1" });
    case "update":
    case "notification":
    case "status.update":
      return JSON.stringify({ stream, event: event.kind, payload: JSON.stringify(event.payload) });
  }
};

/** A client's `subscribe` / `unsubscribe` message, as Mastodon's streaming server reads it. */
const StreamCommandSchema = z.object({
  type: z.union([z.literal("subscribe"), z.literal("unsubscribe")]),
  stream: z.string(),
  tag: z.string().optional(),
  list: z.union([z.string(), z.number()]).optional(),
});

const parseStreamCommand = schemaResult(StreamCommandSchema);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * One viewer's open streaming sockets (an account's, or every anonymous
 * one). Each socket carries the streams it subscribed to in its attachment,
 * so they survive hibernation, and hears only events for those streams.
 */
export class StreamHub extends DurableObject<Env> {
  async publish(raw: unknown): Promise<void> {
    const delivery = StreamDelivery.parse(raw);
    if (delivery.isErr()) {
      return;
    }
    const wanted = new Set(delivery.value.channels.map(StreamChannel.key));
    for (const socket of this.ctx.getWebSockets()) {
      for (const channel of this.stateOf(socket)?.channels ?? []) {
        if (wanted.has(StreamChannel.key(channel))) {
          socket.send(mastodonStreamMessage(channel, delivery.value.event));
        }
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const state = parseSocketState(parseJson(request.headers.get(SOCKET_STATE_HEADER) ?? ""));
    if (state.isErr()) {
      return new Response("Missing socket state", { status: 400 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(state.value);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** `subscribe` / `unsubscribe` messages change which streams the socket hears. */
  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const command = parseStreamCommand(
      typeof message === "string" ? parseJson(message) : undefined,
    );
    const state = this.stateOf(socket);
    if (command.isErr() || !state) {
      socket.send(JSON.stringify({ error: "Invalid message", status: 400 }));
      return;
    }
    const wire = {
      stream: command.value.stream,
      tag: command.value.tag,
      list: command.value.list === undefined ? undefined : String(command.value.list),
    };
    const channel: Result<StreamChannelValue, StreamRefusal> =
      command.value.type === "subscribe"
        ? await requestStreamChannel(this.env, state.viewer, wire)
        : StreamChannel.fromWire(wire);
    if (channel.isErr()) {
      socket.send(JSON.stringify(streamRefusalError(channel.error)));
      return;
    }
    const target = StreamChannel.key(channel.value);
    // Read again: other messages may have changed the socket while this one waited.
    const current = this.stateOf(socket);
    if (!current) {
      return;
    }
    const held = current.channels.some((existing) => StreamChannel.key(existing) === target);
    if (command.value.type === "subscribe" && held) {
      return;
    }
    const channels =
      command.value.type === "subscribe"
        ? [...current.channels, channel.value]
        : current.channels.filter((existing) => StreamChannel.key(existing) !== target);
    socket.serializeAttachment({ ...current, channels } satisfies SocketState);
  }

  private stateOf(socket: WebSocket): SocketState | undefined {
    const state = parseSocketState(socket.deserializeAttachment());
    return state.isOk() ? state.value : undefined;
  }
}
