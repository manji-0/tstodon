import { DurableObject } from "cloudflare:workers";
import { StreamEvent, type StreamEvent as StreamEventValue } from "@tstodon/domain";

/**
 * Mastodon's streaming message for an event on the account's `user` stream:
 * `{ stream, event, payload }`, with an object payload sent as a JSON string,
 * as the web UI and other clients expect.
 */
export const mastodonStreamMessage = (event: StreamEventValue): string => {
  switch (event.kind) {
    case "delete":
      return JSON.stringify({ stream: ["user"], event: "delete", payload: event.statusId });
    case "notifications_merged":
      return JSON.stringify({ stream: ["user"], event: "notifications_merged", payload: "1" });
    case "update":
    case "notification":
    case "status.update":
      return JSON.stringify({
        stream: event.kind === "notification" ? ["user", "user:notification"] : ["user"],
        event: event.kind,
        payload: JSON.stringify(event.payload),
      });
  }
};

/** One account's open streaming sockets; every event goes to all of them. */
export class StreamHub extends DurableObject<Env> {
  async publish(raw: unknown): Promise<void> {
    const parsed = StreamEvent.parse(raw);
    if (parsed.isErr()) {
      return;
    }
    const message = mastodonStreamMessage(parsed.value);
    for (const socket of this.ctx.getWebSockets()) {
      socket.send(message);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * Clients send `subscribe` / `unsubscribe` messages for the streams they
   * want; every connection here already carries the account's user stream,
   * and public streams are not served, so the messages need no answer.
   */
  override webSocketMessage(): void {}
}
