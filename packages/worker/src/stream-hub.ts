import { DurableObject } from "cloudflare:workers";
import {
  StreamChannel,
  type StreamChannelValue,
  StreamDelivery,
  type StreamEventValue,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { RepositoryError } from "./d1";
import {
  hubName,
  parseSocketState,
  requestStreamChannel,
  type SocketState,
  type StreamAccess,
  type StreamRefusal,
  streamRefusalError,
} from "./stream-access";
import {
  deleteSubscriptionRow,
  insertSubscriptionRow,
  subscriptionRow,
} from "./stream-subscription-store";

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
 * Every anonymous socket shares one hub, so they share this budget.
 */
export const MAX_HUB_TAGGED_CHANNELS = 32;

/** The header the streaming route hands a new socket's state to its hub in. */
export const SOCKET_STATE_HEADER = "x-tstodon-stream-socket";

/**
 * Mastodon's streaming message for an event on one stream:
 * `{ stream, event, payload }`, with an object payload sent as a JSON string,
 * as the web UI and other clients expect.
 */
const mastodonStreamMessage = (channel: StreamChannelValue, event: StreamEventValue): string => {
  const stream = StreamChannel.streamName(channel);
  switch (event.kind) {
    case "delete":
      return JSON.stringify({ stream, event: "delete", payload: event.statusId });
    case "notifications_merged":
      return JSON.stringify({ stream, event: "notifications_merged", payload: "1" });
    case "update":
    case "notification":
    case "status.update":
    case "conversation":
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

  /** Deliver to this hub, which `publishToHub` names as `hub`. */
  async publish(hub: string, raw: unknown): Promise<void> {
    const delivery = StreamDelivery.parse(raw);
    if (delivery.isErr()) {
      return;
    }
    const wanted = new Set(delivery.value.channels.map(StreamChannel.key));
    for (const socket of this.openSockets()) {
      const state = this.stateOf(socket);
      for (const channel of state?.channels ?? []) {
        if (
          wanted.has(StreamChannel.key(channel)) &&
          state &&
          mayHear(state.access, delivery.value.event)
        ) {
          socket.send(mastodonStreamMessage(channel, delivery.value.event));
        }
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
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const state = parseSocketState(parseJson(request.headers.get(SOCKET_STATE_HEADER) ?? ""));
    if (state.isErr()) {
      return new Response("Missing socket state", { status: 400 });
    }
    const hub = hubName(state.value.viewer);
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
    const channel = await requestStreamChannel(this.env, state.viewer, state.access, wire);
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
    const hub = hubName(state.viewer);
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
    await this.dropRowIfUnheld(hubName(state.viewer), channel.value);
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
        await this.dropRowIfUnheld(hubName(state.viewer), channel);
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
      this.openSockets()
        .flatMap((socket) => this.stateOf(socket)?.channels ?? [])
        .filter(isTagged)
        .map(StreamChannel.key),
    );
    for (const channel of adding.filter(isTagged)) {
      tagged.add(StreamChannel.key(channel));
    }
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
    return new Set(
      this.openSockets()
        .flatMap((socket) => this.stateOf(socket)?.channels ?? [])
        .map(StreamChannel.key),
    );
  }

  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  private stateOf(socket: WebSocket): SocketState | undefined {
    const state = parseSocketState(socket.deserializeAttachment());
    return state.isOk() ? state.value : undefined;
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
