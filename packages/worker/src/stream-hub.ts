import { DurableObject } from "cloudflare:workers";
import {
  StreamChannel,
  type StreamChannelValue,
  StreamDelivery,
  type StreamEventValue,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { ok, type Result } from "neverthrow";
import { z } from "zod";
import type { RepositoryError } from "./d1";
import {
  hubName,
  parseSocketState,
  requestStreamChannel,
  type SocketState,
  streamRefusalError,
} from "./stream-access";
import { replaceHubSubscriptions, subscriptionRow } from "./stream-subscription-store";

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
 * `stream_subscriptions`, where fan-outs look for whom to tell. Rows are
 * written before a subscription takes effect and removed after it ends, so
 * they always cover the live ones; a row left behind (a hub evicted without
 * close events) is removed the first time a fan-out finds nobody behind it.
 */
export class StreamHub extends DurableObject<Env> {
  /** Subscriptions whose rows are being written, not yet on their socket. */
  private readonly adding: StreamChannelValue[] = [];

  /** Row writes run one at a time, each from the state current when it runs. */
  private syncing: Promise<unknown> = Promise.resolve();

  /** The channel keys the rows were last written from, to skip writes that change nothing. */
  private synced: string | undefined;

  /** Deliver to this hub, which `publishToHub` names as `hub`. */
  async publish(hub: string, raw: unknown): Promise<void> {
    const delivery = StreamDelivery.parse(raw);
    if (delivery.isErr()) {
      return;
    }
    const wanted = new Set(delivery.value.channels.map(StreamChannel.key));
    const reached = new Set<string>();
    for (const socket of this.openSockets()) {
      for (const channel of this.stateOf(socket)?.channels ?? []) {
        const key = StreamChannel.key(channel);
        if (wanted.has(key)) {
          reached.add(key);
          socket.send(mastodonStreamMessage(channel, delivery.value.event));
        }
      }
    }
    const unheard = delivery.value.channels.some(
      (channel) => subscriptionRow(channel) && !reached.has(StreamChannel.key(channel)),
    );
    if (unheard) {
      await this.syncSubscriptions(hub);
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
    const written = await this.subscribeWithRows(
      hubName(state.value.viewer),
      state.value.channels,
      () => {
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].serializeAttachment(state.value);
      },
    );
    if (written.isErr()) {
      return Response.json(streamRefusalError({ kind: "Unavailable" }), { status: 503 });
    }
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
    if (command.value.type === "unsubscribe") {
      const channel = StreamChannel.fromWire(wire);
      if (channel.isErr()) {
        socket.send(JSON.stringify(streamRefusalError(channel.error)));
        return;
      }
      const target = StreamChannel.key(channel.value);
      socket.serializeAttachment({
        ...state,
        channels: state.channels.filter((held) => StreamChannel.key(held) !== target),
      } satisfies SocketState);
      if (subscriptionRow(channel.value)) {
        await this.syncSubscriptions(hubName(state.viewer));
      }
      return;
    }
    const channel = await requestStreamChannel(this.env, state.viewer, wire);
    if (channel.isErr()) {
      socket.send(JSON.stringify(streamRefusalError(channel.error)));
      return;
    }
    const written = await this.subscribeWithRows(hubName(state.viewer), [channel.value], () => {
      // Read again: other messages may have changed the socket while this one waited.
      const current = this.stateOf(socket);
      const target = StreamChannel.key(channel.value);
      if (current && !current.channels.some((held) => StreamChannel.key(held) === target)) {
        socket.serializeAttachment({
          ...current,
          channels: [...current.channels, channel.value],
        } satisfies SocketState);
      }
    });
    if (written.isErr()) {
      socket.send(JSON.stringify(streamRefusalError({ kind: "Unavailable" })));
    }
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.syncAfterClose(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.syncAfterClose(socket);
  }

  private async syncAfterClose(socket: WebSocket): Promise<void> {
    const state = this.stateOf(socket);
    if (state?.channels.some((channel) => subscriptionRow(channel))) {
      await this.syncSubscriptions(hubName(state.viewer));
    }
  }

  /**
   * Write rows for channels about to be subscribed, then `attach` them to
   * their socket. They count as pending until attached, in the same turn, so
   * no row write in between drops them. Sockets on `user*` streams alone
   * never touch D1.
   */
  private async subscribeWithRows(
    hub: string,
    channels: ReadonlyArray<StreamChannelValue>,
    attach: () => void,
  ): Promise<Result<void, RepositoryError>> {
    if (!channels.some((channel) => subscriptionRow(channel))) {
      attach();
      return ok(undefined);
    }
    this.adding.push(...channels);
    try {
      const written = await this.syncSubscriptions(hub);
      if (written.isOk()) {
        attach();
      }
      return written;
    } finally {
      for (const channel of channels) {
        const index = this.adding.indexOf(channel);
        if (index >= 0) {
          this.adding.splice(index, 1);
        }
      }
    }
  }

  /** Make the hub's `stream_subscriptions` rows match its open sockets (and pending subscriptions). */
  private syncSubscriptions(hub: string): Promise<Result<void, RepositoryError>> {
    const run = this.syncing.then(async (): Promise<Result<void, RepositoryError>> => {
      const channels = new Map<string, StreamChannelValue>();
      for (const channel of [
        ...this.openSockets().flatMap((socket) => this.stateOf(socket)?.channels ?? []),
        ...this.adding,
      ]) {
        if (subscriptionRow(channel)) {
          channels.set(StreamChannel.key(channel), channel);
        }
      }
      const signature = JSON.stringify([...channels.keys()].toSorted());
      if (signature === this.synced) {
        return ok(undefined);
      }
      const written = await replaceHubSubscriptions(this.env.DB, hub, [...channels.values()]);
      if (written.isOk()) {
        this.synced = signature;
      }
      return written;
    });
    this.syncing = run.catch(() => undefined);
    return run;
  }

  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  private stateOf(socket: WebSocket): SocketState | undefined {
    const state = parseSocketState(socket.deserializeAttachment());
    return state.isOk() ? state.value : undefined;
  }
}
